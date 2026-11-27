//! Removal under K20: under the exclusive gate, the state record says
//! `removing` before anything is deleted; the command link goes only while it
//! still points to the installation, each owned file goes only while it is a
//! regular file under exactly its spelling, the installed removal tool goes
//! last of the files, and folders go only once they are empty. Anything else
//! is kept and reported. The state record is deleted last, once every owned
//! file is gone; the gate and its folder stay (K21).

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{Phase, State};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::{Problem, Report};

/// The installed removal tool, removed after every other owned file.
const TOOL: &str = "maintenance/urx-uninstall";

/// What happened to one owned path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Removal {
    Removed,
    /// Nothing was there under exactly this spelling.
    Missing,
    /// Something other than the installation's file was there, at this path
    /// under the root, and was kept.
    Kept(String),
}

/// Removes the owned file `path` under `root` while it is a regular file
/// listed under exactly that spelling: a file the file system finds only
/// under another letter case is another path's, and is kept. With
/// `pending_ours`, a pending file beside it is maintenance's and goes too.
pub(crate) fn remove_owned(
    layout: &Layout,
    root: &Fd,
    path: &str,
    pending_ours: bool,
) -> Result<Removal, Problem> {
    let (parent, name) = match tree::parent_of(root, path, Some(layout.owner), How::Exact) {
        Ok(Some(found)) => found,
        Ok(None) => return Ok(Removal::Missing),
        Err(WalkError::Conflict(at)) => return Ok(Removal::Kept(at)),
        Err(WalkError::Io(_)) => return Err(Problem::Write(layout.root.join(path))),
    };
    let failed = |_| Problem::Write(layout.root.join(path));
    if pending_ours {
        let pending = place::pending(&name);
        if let Spelled::Exact(entry) = tree::spelled(&parent, &pending).map_err(failed)? {
            if entry.kind == Kind::File {
                sys::remove_at(&parent, &pending, false).map_err(failed)?;
            }
        }
    }
    match tree::spelled(&parent, &name).map_err(failed)? {
        Spelled::Missing | Spelled::Other { .. } => Ok(Removal::Missing),
        Spelled::Exact(entry) if entry.kind == Kind::File => {
            sys::remove_at(&parent, &name, false).map_err(failed)?;
            sys::flush(parent.raw()).map_err(failed)?;
            Ok(Removal::Removed)
        }
        Spelled::Exact(_) => Ok(Removal::Kept(path.to_owned())),
    }
}

/// Removes the folders of `path` under `root` that are empty, deepest
/// first, stopping at the first that is not, or that is there only under
/// another spelling.
pub(crate) fn prune(layout: &Layout, root: &Fd, path: &str) -> Result<(), Problem> {
    let names: Vec<&str> = path.split('/').collect();
    for depth in (1..names.len()).rev() {
        let folder = names[..depth].join("/");
        let failed = || Problem::Write(layout.root.join(&folder));
        let (parent, name) = match tree::parent_of(root, &folder, Some(layout.owner), How::Exact) {
            Ok(Some(found)) => found,
            Ok(None) | Err(WalkError::Conflict(_)) => return Ok(()),
            Err(WalkError::Io(_)) => return Err(failed()),
        };
        match tree::spelled(&parent, &name) {
            Ok(Spelled::Exact(entry)) if place::is_ours(&entry, Kind::Folder, layout.owner) => {}
            Ok(Spelled::Missing) => continue,
            _ => return Ok(()),
        }
        match sys::remove_at(&parent, &name, true) {
            Ok(_) => sys::flush(parent.raw()).map_err(|_| failed())?,
            Err(error)
                if matches!(
                    error.raw_os_error(),
                    Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
                ) =>
            {
                return Ok(())
            }
            Err(_) => return Err(failed()),
        }
    }
    Ok(())
}

/// Removes the installation. Without `apply` it only reports what an apply
/// would remove, and changes nothing. `stop` is asked before each change;
/// once it answers true, nothing more is changed and the record stays
/// `removing`, for removal to be run again: by this tool while it is
/// installed, by the copy in the disk image or the recovery ZIP once the
/// installed one is gone.
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
    // A pending file is maintenance's only while a run of its own is unfinished.
    let pending_ours = state.phase != Phase::Complete;
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
    // The removal tool last, so that while any other owned file is left, the installed one is too.
    let mut order: Vec<&String> = state
        .owned
        .iter()
        .filter(|path| path.as_str() != TOOL)
        .collect();
    order.extend(state.owned.iter().filter(|path| path.as_str() == TOOL));
    let mut tool_gone = false;
    // Once the installed tool is gone, a removal left unfinished is finished by another copy.
    let unfinished = |problem: Problem, tool_gone: bool| {
        if tool_gone && matches!(problem, Problem::Interrupted | Problem::Write(_)) {
            Problem::RemovalUnfinished {
                interrupted: problem == Problem::Interrupted,
            }
        } else {
            problem
        }
    };
    if let Some(root) = &root {
        for path in order {
            if stop() {
                return Err(unfinished(Problem::Interrupted, tool_gone));
            }
            match remove_owned(layout, root, path, pending_ours)
                .map_err(|problem| unfinished(problem, tool_gone))?
            {
                Removal::Kept(at) => report.line(format!(
                    "Kept {}: it is not a file the installation made.",
                    layout.root.join(at).display()
                )),
                Removal::Removed | Removal::Missing => {}
            }
            tool_gone |= path == TOOL;
        }
        for path in &state.owned {
            prune(layout, root, path).map_err(|problem| unfinished(problem, true))?;
        }
    }
    if stop() {
        return Err(unfinished(Problem::Interrupted, true));
    }
    let root_kept = remove_root(layout).map_err(|problem| unfinished(problem, true))?;
    if root_kept {
        report.line(format!(
            "Kept {}: it holds files the installation did not make.",
            layout.root.display()
        ));
    }
    held.remove_state()
        .map_err(|problem| unfinished(problem, true))?;
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
