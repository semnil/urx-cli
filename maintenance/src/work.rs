//! The work folder beside the root (K41 as revised), as both tools find and
//! clear it: told by its inode, never by its name or what it holds.

use crate::journal::{self, JOURNAL};
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
    /// when another object took its name). `journal` says its journal is
    /// still in it, to be removed (`drop_journal`) once the record no longer
    /// names the folder.
    Kept { kept: Vec<String>, journal: bool },
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
/// its journal with `check`, by its list, the journal included, otherwise),
/// the release manifest after the others, and the folder once nothing else
/// is in it. The recorded folder no longer as maintenance makes it, a
/// folder of the installation's in it that is not, a journal that is not
/// maintenance's, or (with no journal) anything at a product path stops it
/// with that path (`Conflict`), and nothing more is removed.
pub fn clear(layout: &Layout, parent: &Fd, volume: u64, work: &Work) -> Result<Cleared, Problem> {
    let path = path_of(layout, work);
    let failed = |_| Problem::Write(path.clone());
    let Some(folder) = open(layout, parent, volume, work)? else {
        let there = place::inode_at(parent, &name_of(work), volume, &path)?.is_some();
        return Ok(if there {
            Cleared::Kept {
                kept: vec![".".to_owned()],
                journal: false,
            }
        } else {
            Cleared::Gone
        });
    };
    let mut files: BTreeSet<String> = work.files.iter().cloned().collect();
    let left = if work.check {
        let names = journal::read(&folder, layout.owner)
            .map_err(|_| Problem::Conflict(path.join(JOURNAL)))?;
        journal::clear(&folder, "", names.as_ref(), &files, layout.owner)
    } else {
        files.insert(JOURNAL.to_owned());
        tree::remove_listed(&folder, "", &files, layout.owner)
    }
    .map_err(failed)?;
    let left = match left {
        Ok(left) => left,
        Err(at) => return Err(Problem::Conflict(path.join(at))),
    };
    if !left.empty {
        let journal = sys::entry_at(&folder, &CString::new(JOURNAL).unwrap_or_default())
            .map_err(failed)?
            .is_some();
        return Ok(Cleared::Kept {
            kept: left.kept,
            journal,
        });
    }
    journal::remove(&folder, layout.owner).map_err(|_| Problem::Conflict(path.join(JOURNAL)))?;
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
            Ok(Cleared::Kept {
                kept: Vec::new(),
                journal: false,
            })
        }
        Err(error) => Err(failed(error)),
    }
}

/// Removes the journal from the work folder `work` names, kept with what is
/// not the installation's, once the record no longer names the folder.
pub fn drop_journal(layout: &Layout, parent: &Fd, volume: u64, work: &Work) -> Result<(), Problem> {
    let path = path_of(layout, work);
    if let Some(folder) = open(layout, parent, volume, work)? {
        journal::remove(&folder, layout.owner)
            .map_err(|_| Problem::Conflict(path.join(JOURNAL)))?;
    }
    Ok(())
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
