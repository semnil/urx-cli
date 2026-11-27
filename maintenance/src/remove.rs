//! Removal under K20: under the exclusive gate, the state record says
//! `removing`, with the files of the tree at the root, before anything is
//! deleted; the command link goes only while it still points to the
//! installation, each of those files goes only while it is a regular file
//! under exactly its spelling, the installed removal tool goes after the
//! others and the release manifest last, and folders go only once they are
//! empty. Anything else is kept and reported. The state record is deleted
//! last, once every one of those files is gone; a failure before that keeps
//! `removing` for the removal to be run again. The gate and its folder stay
//! (K21).

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{digest, pending_tag, Manifest, Phase, State, MANIFEST};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::{Problem, Report};
use std::collections::BTreeSet;
use std::path::Path;

/// The installed removal tool, removed after every other file but the manifest.
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
/// under another letter case is another path's, and is kept.
pub(crate) fn remove_owned(layout: &Layout, root: &Fd, path: &str) -> Result<Removal, Problem> {
    let (parent, name) = match tree::parent_of(root, path, Some(layout.owner), How::Exact) {
        Ok(Some(found)) => found,
        Ok(None) => return Ok(Removal::Missing),
        Err(WalkError::Conflict(at)) => return Ok(Removal::Kept(at)),
        Err(WalkError::Io(_)) => return Err(Problem::Write(layout.root.join(path))),
    };
    let failed = |_| Problem::Write(layout.root.join(path));
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

/// The files of the tree at the root that the record names. Once complete or
/// removing, the record's owned paths. While installing, the release's when
/// the root holds the release manifest the record names (the swap was made),
/// the complete installation's otherwise. A file that cannot be read stops
/// the removal before it changes anything.
fn tree_of(layout: &Layout, root: Option<&Fd>, state: &State) -> Result<Vec<String>, Problem> {
    if state.phase != Phase::Installing {
        return Ok(state.owned.clone());
    }
    let Some(root) = root else {
        return Ok(state.base_paths().to_vec());
    };
    let unreadable = || Problem::Write(layout.root.join(MANIFEST));
    let found = match tree::parent_of(root, MANIFEST, None, How::Exact) {
        Ok(Some((parent, name))) => {
            match tree::spelled(&parent, &name).map_err(|_| unreadable())? {
                Spelled::Exact(entry) if entry.kind == Kind::File => Some((parent, name)),
                _ => None,
            }
        }
        Ok(None) => None,
        Err(_) => return Err(unreadable()),
    };
    let Some((parent, name)) = found else {
        return Ok(state.base_paths().to_vec());
    };
    use std::io::Read;
    let (file, _) = sys::open_file_at(&parent, &name).map_err(|_| unreadable())?;
    let mut bytes = Vec::new();
    file.take(8 << 20)
        .read_to_end(&mut bytes)
        .map_err(|_| unreadable())?;
    if digest(&bytes) == state.manifest {
        let manifest = Manifest::parse(&bytes).ok_or_else(unreadable)?;
        Ok(manifest.owned())
    } else {
        Ok(state.base_paths().to_vec())
    }
}

/// Removes the installation. Without `apply` it only reports what an apply
/// would remove, and changes nothing. `stop` is asked before each change;
/// once it answers true, nothing more is changed and the record stays
/// `removing`, for removal to be run again: by this tool while it is
/// installed, by the copy in the disk image or the recovery ZIP once the
/// installed one is gone.
pub fn uninstall(layout: &Layout, apply: bool, stop: &dyn Fn() -> bool) -> Result<Report, Problem> {
    // The names removed are in these folders: no one but root may be able to change them.
    place::check_not_exposed(layout)?;
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
    let parent = place::root_parent(layout, false)?;
    let root_name = std::ffi::CString::new(std::os::unix::ffi::OsStrExt::as_bytes(
        layout.root.file_name().unwrap_or_default(),
    ))
    .unwrap_or_default();
    let root = match &parent {
        Some(parent) => place::open_ours(parent, &root_name, &layout.root, layout.owner)?,
        None => None,
    };
    let Some(state) = state else {
        if root.is_some() {
            return Err(Problem::Unrecorded(layout.root.clone()));
        }
        let mut report = Report::default();
        report.line("urx-cli is not installed; nothing was removed.".to_owned());
        return Ok(report);
    };
    let link = place::link_state(layout)?;
    let files = tree_of(layout, root.as_ref(), &state)?;
    if !apply {
        let mut report = Report::default();
        report.line(format!(
            "Would remove urx-cli {} from {}: the {} files it installed{}.",
            state.release,
            layout.root.display(),
            files.len(),
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
    let tag = pending_tag(&state.manifest).to_owned();
    if stop() {
        return Err(Problem::Interrupted);
    }
    held.write_state(&State {
        phase: Phase::Removing,
        owned: files.clone(),
        base: Some(files.clone()),
        ..state.clone()
    })?;
    let mut report = Report::default();
    // Once the installed tool is gone, a removal left unfinished is finished by another copy:
    // whether it is there is read when the removal stops, whatever stopped it.
    let unfinished = |problem: Problem| {
        let tool_left = root.as_ref().is_some_and(|root| {
            matches!(tree::parent_of(root, TOOL, None, How::Exact), Ok(Some((parent, name)))
                if matches!(tree::spelled(&parent, &name), Ok(Spelled::Exact(entry)) if entry.kind == Kind::File))
        });
        if !tool_left && matches!(problem, Problem::Interrupted | Problem::Write(_)) {
            Problem::RemovalUnfinished {
                interrupted: problem == Problem::Interrupted,
            }
        } else {
            problem
        }
    };
    if stop() {
        return Err(unfinished(Problem::Interrupted));
    }
    if !place::remove_link(layout).map_err(&unfinished)? && link == LinkState::Foreign {
        report.line(format!(
            "Kept {}: it does not point to the installation.",
            layout.link.display()
        ));
    }
    // A work folder an interrupted installation of this release left, by its recorded files.
    if let Some(parent) = &parent {
        let staging_path = place::staging(layout, &tag);
        let mut listed: BTreeSet<String> = state.owned.iter().cloned().collect();
        listed.extend(files.iter().cloned());
        if !clear_staging(layout, parent, &staging_path, &listed).map_err(&unfinished)? {
            report.line(format!(
                "Kept {}: it holds files the installation did not make.",
                staging_path.display()
            ));
        }
    }
    // The removal tool after the others, so that while any other file is left, the installed one
    // is too; the manifest last.
    let mut order: Vec<&String> = files
        .iter()
        .filter(|path| path.as_str() != TOOL && path.as_str() != MANIFEST)
        .collect();
    order.extend(files.iter().filter(|path| path.as_str() == TOOL));
    order.extend(files.iter().filter(|path| path.as_str() == MANIFEST));
    if let Some(root) = &root {
        for path in order {
            if stop() {
                return Err(unfinished(Problem::Interrupted));
            }
            match remove_owned(layout, root, path).map_err(&unfinished)? {
                Removal::Kept(at) => report.line(format!(
                    "Kept {}: it is not a file the installation made.",
                    layout.root.join(at).display()
                )),
                Removal::Removed | Removal::Missing => {}
            }
        }
        for path in &files {
            prune(layout, root, path).map_err(&unfinished)?;
        }
    }
    if stop() {
        return Err(unfinished(Problem::Interrupted));
    }
    let root_kept = remove_root(layout).map_err(&unfinished)?;
    if root_kept {
        report.line(format!(
            "Kept {}: it holds files the installation did not make.",
            layout.root.display()
        ));
    }
    held.remove_state(&tag).map_err(&unfinished)?;
    report.line(format!("Removed urx-cli {}.", state.release));
    Ok(report)
}

/// Removes the work folder at `path` beside the root by the recorded files
/// in it; true when it is gone or was never there.
fn clear_staging(
    layout: &Layout,
    parent: &Fd,
    path: &Path,
    listed: &BTreeSet<String>,
) -> Result<bool, Problem> {
    let name = sys::c_name(std::os::unix::ffi::OsStrExt::as_bytes(
        path.file_name().unwrap_or_default(),
    ))
    .map_err(|_| Problem::Write(path.to_path_buf()))?;
    let Some(staging) = place::open_ours(parent, &name, path, layout.owner)? else {
        return Ok(true);
    };
    let failed = |_| Problem::Write(path.to_path_buf());
    if !tree::clear_listed(&staging, "", listed, layout.owner).map_err(failed)? {
        return Ok(false);
    }
    drop(staging);
    match sys::remove_at(parent, &name, true) {
        Ok(_) => {
            sys::flush(parent.raw()).map_err(failed)?;
            Ok(true)
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(failed(error)),
    }
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
