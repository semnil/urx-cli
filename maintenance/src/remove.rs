//! Removal under K20: under the exclusive gate, the state record says
//! `removing` before anything is deleted; the command link goes only while it
//! still points to the installation, each owned file goes only while it is a
//! regular file, and folders go only once they are empty. Anything else is
//! kept and reported. The state record is deleted last, once every owned
//! file is gone; the gate and its folder stay (K21).

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{Phase, State};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, WalkError};
use crate::{Problem, Report};

/// What happened to one owned path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    Removed,
    /// Nothing was there.
    Missing,
    /// Something other than the installation's file was there, at this path
    /// under the root, and was kept.
    Kept(String),
}

/// Removes the owned file `path` under `root` while it is a regular file.
pub(crate) fn remove_owned(layout: &Layout, root: &Fd, path: &str) -> Result<Removal, Problem> {
    let (parent, name) = match tree::parent_of(root, path, Some(layout.owner), false) {
        Ok(Some(found)) => found,
        Ok(None) => return Ok(Removal::Missing),
        Err(WalkError::Conflict(at)) => return Ok(Removal::Kept(at)),
        Err(WalkError::Io(_)) => return Err(Problem::Write(layout.root.join(path))),
    };
    let failed = |_| Problem::Write(layout.root.join(path));
    // A pending file maintenance left beside it is maintenance's too.
    sys::remove_at(&parent, &place::pending(&name), false).map_err(failed)?;
    match sys::entry_at(&parent, &name).map_err(failed)? {
        None => Ok(Removal::Missing),
        Some(entry) if entry.kind == Kind::File => {
            sys::remove_at(&parent, &name, false).map_err(failed)?;
            sys::flush(parent.raw()).map_err(failed)?;
            Ok(Removal::Removed)
        }
        Some(_) => Ok(Removal::Kept(path.to_owned())),
    }
}

/// Removes the folders of `path` under `root` that are empty, deepest
/// first, stopping at the first that is not.
pub(crate) fn prune(layout: &Layout, root: &Fd, path: &str) -> Result<(), Problem> {
    let names: Vec<&str> = path.split('/').collect();
    for depth in (1..names.len()).rev() {
        let folder = names[..depth].join("/");
        let (parent, name) = match tree::parent_of(root, &folder, Some(layout.owner), false) {
            Ok(Some(found)) => found,
            Ok(None) | Err(WalkError::Conflict(_)) => return Ok(()),
            Err(WalkError::Io(_)) => return Err(Problem::Write(layout.root.join(&folder))),
        };
        match sys::entry_at(&parent, &name) {
            Ok(Some(entry)) if place::is_ours(&entry, Kind::Folder, layout.owner) => {}
            Ok(None) => continue,
            _ => return Ok(()),
        }
        match sys::remove_at(&parent, &name, true) {
            Ok(_) => {
                sys::flush(parent.raw()).map_err(|_| Problem::Write(layout.root.join(&folder)))?
            }
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
                ) =>
            {
                return Ok(())
            }
            Err(_) => return Err(Problem::Write(layout.root.join(&folder))),
        }
    }
    Ok(())
}

/// Removes the installation. Without `apply` it only reports what an apply
/// would remove, and changes nothing. `stop` is asked before each change;
/// once it answers true, nothing more is changed and the record stays
/// `removing`, for removal to be run again.
pub fn uninstall(layout: &Layout, apply: bool, stop: &dyn Fn() -> bool) -> Result<Report, Problem> {
    let held = place::hold(
        layout,
        if apply {
            Access::Write { create: false }
        } else {
            Access::Read
        },
    )?;
    let state = match &held {
        Some(held) => held.state(layout.owner)?,
        None => None,
    };
    let root = place::open_root(layout, false)?;
    let Some(state) = state else {
        if root.is_some() {
            return Err(Problem::Unrecorded(layout.root.clone()));
        }
        let mut report = Report::default();
        report.line("urx-cli is not installed; nothing was removed.".to_owned());
        return Ok(report);
    };
    let link = place::link_state(layout)?;
    if !apply {
        let mut report = Report::default();
        report.line(format!(
            "Would remove urx-cli {} from {}: the {} files it installed{}.",
            state.release,
            layout.root.display(),
            state.owned.len(),
            if link == LinkState::Owned {
                format!(" and the link {}", layout.link.display())
            } else {
                String::new()
            }
        ));
        if link == LinkState::Foreign {
            report.line(format!(
                "Would keep {}: it does not point to the installation.",
                layout.link.display()
            ));
        }
        report
            .line("Nothing was changed. Run it again with sudo and --apply to remove.".to_owned());
        return Ok(report);
    }
    let held = held.expect("an apply holds the gate");
    if stop() {
        return Err(Problem::Interrupted);
    }
    held.write_state(&State {
        phase: Phase::Removing,
        ..state.clone()
    })?;
    let mut report = Report::default();
    if stop() {
        return Err(Problem::Interrupted);
    }
    if !place::remove_link(layout)? && link == LinkState::Foreign {
        report.line(format!(
            "Kept {}: it does not point to the installation.",
            layout.link.display()
        ));
    }
    if let Some(root) = &root {
        for path in &state.owned {
            if stop() {
                return Err(Problem::Interrupted);
            }
            if let Removal::Kept(at) = remove_owned(layout, root, path)? {
                report.line(format!(
                    "Kept {}: it is not a file the installation made.",
                    layout.root.join(at).display()
                ));
            }
        }
        for path in &state.owned {
            prune(layout, root, path)?;
        }
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    let root_kept = remove_root(layout)?;
    if root_kept {
        report.line(format!(
            "Kept {}: it holds files the installation did not make.",
            layout.root.display()
        ));
    }
    held.remove_state()?;
    report.line(format!("Removed urx-cli {}.", state.release));
    Ok(report)
}

/// Removes the root once it is empty; true when it is kept, holding something.
fn remove_root(layout: &Layout) -> Result<bool, Problem> {
    let Some(parent_path) = layout.root.parent() else {
        return Ok(false);
    };
    let Ok(parent) = sys::open_system_folder(parent_path) else {
        return Ok(false);
    };
    let name = sys::c_name(std::os::unix::ffi::OsStrExt::as_bytes(
        layout.root.file_name().unwrap_or_default(),
    ))
    .map_err(|_| Problem::Write(layout.root.clone()))?;
    match sys::entry_at(&parent, &name) {
        Ok(Some(entry)) if place::is_ours(&entry, Kind::Folder, layout.owner) => {}
        Ok(None) => return Ok(false),
        _ => return Ok(true),
    }
    match sys::remove_at(&parent, &name, true) {
        Ok(_) => {
            sys::flush(parent.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
            Ok(false)
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
            ) =>
        {
            Ok(true)
        }
        Err(_) => Err(Problem::Write(layout.root.clone())),
    }
}
