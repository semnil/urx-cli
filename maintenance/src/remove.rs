//! Removal under K20: under the exclusive gate, the state record says
//! `removing`, with the files of the tree at the root and the root's inode,
//! before anything is deleted; a folder at the root's name that is not the
//! recorded tree stops it. The command link goes only while it still points to the
//! installation, each of those files goes only while it is a regular file
//! under exactly its spelling, the installed removal tool goes after the
//! others and the release manifest last, and folders go only once they are
//! empty. Anything else is kept and reported. The state record is deleted
//! last, once every one of those files is gone; a failure before that keeps
//! `removing` for the removal to be run again. The gate and its folder stay
//! (K21).

use crate::journal::JOURNAL;
use crate::place::{self, Access, Layout, LinkState};
use crate::records::{pending_tag, Phase, State, Work, MANIFEST};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::work::{self, Cleared};
use crate::{Problem, Report};

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
        // A folder on the way that is not as the installation made it: whether the file is
        // still there cannot be told, so the removal stops with its record.
        Err(WalkError::Conflict(at)) => return Err(Problem::Conflict(layout.root.join(at))),
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
    let volume = match &parent {
        Some(parent) => Some(place::volume_of(parent, &layout.root)?),
        None => None,
    };
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
    // The files of the tree at the root, and the work folder beside it, from the record and the
    // objects' inodes (K41 as revised).
    let (files, root_id, work) = trees(layout, parent.as_ref(), volume, root.as_ref(), &state)?;
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
    // The record keeps what is left in both places: the tree at the root, and the work folder
    // an interrupted installation recorded.
    let removing = State {
        phase: Phase::Removing,
        owned: files.clone(),
        base: None,
        previous: None,
        root: root_id,
        work: work.clone(),
        ..state.clone()
    };
    held.write_state(&removing)?;
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
    // The work folder an interrupted installation left, by its inode: the previous tree by its
    // list, a release partly assembled by its journal.
    if let (Some(parent), Some(volume), Some(work)) = (&parent, volume, &work) {
        if let Cleared::Kept { kept, journal } =
            work::clear(layout, parent, volume, work).map_err(&unfinished)?
        {
            report.line(work::kept_line(layout, work, &kept));
            if journal {
                // Kept with what is not the installation's: no longer recorded, so its journal
                // can go.
                held.write_state(&State {
                    work: None,
                    ..removing.clone()
                })
                .map_err(&unfinished)?;
                work::drop_journal(layout, parent, volume, work).map_err(&unfinished)?;
            }
        }
    }
    // The removal tool after the others, so that while any other file is left, the installed one
    // is too; the manifest last.
    // The journal a release put in place may still have at the top goes with the others.
    let journal = JOURNAL.to_owned();
    let mut order: Vec<&String> = files
        .iter()
        .filter(|path| path.as_str() != TOOL && path.as_str() != MANIFEST)
        .collect();
    order.push(&journal);
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

/// The files of the tree at the root, the root's inode, and the work folder beside it.
type Trees = (Vec<String>, Option<u64>, Option<Work>);

/// The files of the tree at the root, the root's inode, and the work
/// folder beside it with what it holds, each told by its inode against the
/// record: the root is the recorded tree (once complete or removing), or
/// while installing the release assembled in `work` or the previous tree
/// (`previous`); any other folder at the root's name stops the removal. A
/// folder at the work folder's name that is neither recorded object is left
/// as it is.
fn trees(
    layout: &Layout,
    parent: Option<&Fd>,
    volume: Option<u64>,
    root: Option<&Fd>,
    state: &State,
) -> Result<Trees, Problem> {
    let root_id = match (root, volume) {
        (Some(root), Some(volume)) => Some(place::inode_on(
            &sys::entry(root.raw()).map_err(|_| Problem::Conflict(layout.root.clone()))?,
            volume,
            &layout.root,
        )?),
        _ => None,
    };
    let installing = state.phase == Phase::Installing;
    let assembled = state
        .work
        .as_ref()
        .filter(|work| installing && work.check)
        .map(|work| work.id);
    let files = match root_id {
        None if installing => Vec::new(),
        None => state.owned.clone(),
        Some(id) if installing && assembled == Some(id) => state.owned.clone(),
        Some(id) if installing && state.previous == Some(id) => {
            state.base.clone().unwrap_or_default()
        }
        Some(id) if !installing && state.root == Some(id) => state.owned.clone(),
        Some(_) => return Err(Problem::Conflict(layout.root.clone())),
    };
    let work = match (parent, volume) {
        (Some(parent), Some(volume)) => work::found(layout, parent, volume, state)?,
        _ => None,
    };
    Ok((files, root_id, work))
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
