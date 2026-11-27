//! The work folder beside the root (K41 as revised), as both tools find and
//! clear it: told by its inode, never by its name or what it holds, and
//! what is in it by its marks (`mark`).

use crate::mark;
use crate::place::{self, is_ours, Layout};
use crate::records::{Phase, State, Work};
use crate::sys::{self, Fd, Kind};
use crate::tree;
use crate::Problem;
use std::collections::BTreeSet;
use std::ffi::CString;
use std::path::PathBuf;

fn path_of(layout: &Layout, work: &Work) -> PathBuf {
    layout.root.with_file_name(&work.name)
}

fn name_of(work: &Work) -> CString {
    CString::new(work.name.as_bytes()).unwrap_or_default()
}

/// What is at the name of the work folder `state` records, beside the root
/// in `parent` (on `volume`), told by its inode: the previous tree while
/// installing (its object `previous`, removed by its list), or the recorded
/// folder, with the files it may hold. None when nothing is there, or
/// another object is, which is left as it is. The recorded object no longer
/// as maintenance makes it (another owner, or writable by others) stops the
/// tool with its path.
pub fn found(
    layout: &Layout,
    parent: &Fd,
    volume: u64,
    state: &State,
) -> Result<Option<Work>, Problem> {
    let Some(work) = &state.work else {
        return Ok(None);
    };
    let path = path_of(layout, work);
    let Some((inode, entry)) = place::inode_at(parent, &name_of(work), volume, &path)? else {
        return Ok(None);
    };
    let installing = state.phase == Phase::Installing;
    let found = if installing && state.previous == Some(inode) {
        Some(Work {
            name: work.name.clone(),
            id: inode,
            files: state.base.clone().unwrap_or_default(),
            check: false,
        })
    } else if inode == work.id {
        Some(Work {
            name: work.name.clone(),
            id: inode,
            files: if installing && work.check {
                state.owned.clone()
            } else {
                work.files.clone()
            },
            check: work.check,
        })
    } else {
        None
    };
    if found.is_some() && !is_ours(&entry, Kind::Folder, layout.owner) {
        return Err(Problem::Conflict(path));
    }
    Ok(found)
}

/// What clearing a work folder left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cleared {
    /// Nothing of it is left.
    Gone,
    /// It holds what is not the installation's, kept: these entries (`.`
    /// when another object took its name).
    Kept(Vec<String>),
}

/// Opens the work folder `work` names while it is that object and as
/// maintenance makes it; None when another object, or nothing, is there.
fn open(layout: &Layout, parent: &Fd, volume: u64, work: &Work) -> Result<Option<Fd>, Problem> {
    let path = path_of(layout, work);
    let conflict = || Problem::Conflict(path.clone());
    let name = name_of(work);
    let Some((inode, entry)) = place::inode_at(parent, &name, volume, &path)? else {
        return Ok(None);
    };
    if inode != work.id {
        return Ok(None);
    }
    if !is_ours(&entry, Kind::Folder, layout.owner) {
        return Err(conflict());
    }
    let folder = sys::open_folder_at(parent, &name).map_err(|_| conflict())?;
    let opened = sys::entry(folder.raw()).map_err(|_| conflict())?;
    if opened.id != entry.id || !is_ours(&opened, Kind::Folder, layout.owner) {
        return Err(conflict());
    }
    Ok(Some(folder))
}

/// Clears the work folder `work` names, beside the root in `parent` (on
/// `volume`), while it is that object: what is the installation's goes (by
/// its marks with `check`, by its list otherwise), the release manifest
/// after the others, and the folder once nothing else is in it. The
/// recorded folder no longer as maintenance makes it, or a folder of the
/// installation's in it that is not, or an entry whose mark cannot be read,
/// stops it with that path (`Conflict`), and nothing more is removed.
pub fn clear(layout: &Layout, parent: &Fd, volume: u64, work: &Work) -> Result<Cleared, Problem> {
    let path = path_of(layout, work);
    let failed = |_| Problem::Write(path.clone());
    let Some(folder) = open(layout, parent, volume, work)? else {
        let there = place::inode_at(parent, &name_of(work), volume, &path)?.is_some();
        return Ok(if there {
            Cleared::Kept(vec![".".to_owned()])
        } else {
            Cleared::Gone
        });
    };
    let left = if work.check {
        mark::clear(&folder, "", work.id, layout.owner)
    } else {
        let files: BTreeSet<String> = work.files.iter().cloned().collect();
        tree::remove_listed(&folder, "", &files, layout.owner)
    }
    .map_err(failed)?;
    let left = match left {
        Ok(left) => left,
        Err(at) => return Err(Problem::Conflict(path.join(at))),
    };
    if !left.empty {
        return Ok(Cleared::Kept(left.kept));
    }
    drop(folder);
    match sys::remove_at(parent, &name_of(work), true) {
        Ok(_) => {
            sys::flush(parent.raw()).map_err(failed)?;
            Ok(Cleared::Gone)
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
            ) =>
        {
            Ok(Cleared::Kept(Vec::new()))
        }
        Err(error) => Err(failed(error)),
    }
}

/// The line that reports a work folder kept.
pub fn kept_line(layout: &Layout, work: &Work, kept: &[String]) -> String {
    let mut kept = kept.to_vec();
    kept.sort_unstable();
    format!(
        "Kept {}: it holds files the installation did not make ({}).",
        path_of(layout, work).display(),
        kept.join(", ")
    )
}
