//! Files under an open folder, reached by relative path one name at a time,
//! never through a link.

use crate::place::is_ours;
use crate::records::MANIFEST;
use crate::sys::{self, Entry, Fd, Kind};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Read};

/// Why a relative path could not be reached.
#[derive(Debug)]
pub enum WalkError {
    /// Something other than a folder maintenance made is where a folder of
    /// the path should be, or the entry is not what it should be: the
    /// relative path of that entry.
    Conflict(String),
    Io(io::Error),
}

impl From<io::Error> for WalkError {
    fn from(error: io::Error) -> Self {
        WalkError::Io(error)
    }
}

/// How a relative path is followed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum How {
    /// By the file system's own lookup.
    Lookup,
    /// Only through folders listed under exactly these names: a folder the
    /// file system finds under another spelling (another letter case) is
    /// not this path's, and the path is missing.
    Exact,
}

/// How a name is spelled in a folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Spelled {
    Missing,
    /// The folder lists this exact name.
    Exact(Entry),
    /// The file system finds the name, but the folder lists it under
    /// `actual`, another letter case, or under no name of that case at all
    /// (None).
    Other {
        actual: Option<CString>,
        entry: Entry,
    },
}

/// What is at `name` in the open folder `parent`, and how it is spelled there.
pub fn spelled(parent: &Fd, name: &CStr) -> io::Result<Spelled> {
    let Some(entry) = sys::entry_at(parent, name)? else {
        return Ok(Spelled::Missing);
    };
    let listed = sys::names(parent)?;
    if listed.iter().any(|listed| listed.as_c_str() == name) {
        return Ok(Spelled::Exact(entry));
    }
    let folded = name.to_bytes().to_ascii_lowercase();
    let actual = listed
        .into_iter()
        .find(|listed| listed.to_bytes().to_ascii_lowercase() == folded);
    Ok(Spelled::Other { actual, entry })
}

/// The open folder holding `path` (relative, `/`-separated) under `root`,
/// and the path's last name, followed as `how` says. Each folder on the way
/// must be a folder, and the `owner`'s writable by no one else when an owner
/// is given. None when a folder on the way is missing (with `Exact`, also
/// when it is there only under another spelling).
pub fn parent_of(
    root: &Fd,
    path: &str,
    owner: Option<u32>,
    how: How,
) -> Result<Option<(Fd, CString)>, WalkError> {
    let names: Vec<&str> = path.split('/').collect();
    let (last, folders) = names.split_last().expect("split gives one name at least");
    let mut current: Option<Fd> = None;
    let mut walked = String::new();
    for folder in folders {
        if !walked.is_empty() {
            walked.push('/');
        }
        walked.push_str(folder);
        let name = sys::c_name(folder.as_bytes())?;
        let parent = current.as_ref().unwrap_or(root);
        let fits = |entry: &Entry| match owner {
            Some(owner) => is_ours(entry, Kind::Folder, owner),
            None => entry.kind == Kind::Folder,
        };
        let found = if how == How::Lookup {
            match sys::entry_at(parent, &name)? {
                None => Spelled::Missing,
                Some(entry) => Spelled::Exact(entry),
            }
        } else {
            spelled(parent, &name)?
        };
        let next = match found {
            Spelled::Missing => return Ok(None),
            Spelled::Exact(entry) => {
                if !fits(&entry) {
                    return Err(WalkError::Conflict(walked));
                }
                sys::open_folder_at(parent, &name)?
            }
            Spelled::Other { entry, .. } if !fits(&entry) => {
                return Err(WalkError::Conflict(walked))
            }
            Spelled::Other { .. } => return Ok(None),
        };
        current = Some(next);
    }
    let parent = match current {
        Some(folder) => folder,
        // The root itself: a second descriptor of it.
        None => sys::duplicate(root)?,
    };
    Ok(Some((parent, sys::c_name(last.as_bytes())?)))
}

/// Checks that everything under the open folder `folder` (at `prefix`,
/// empty or ending with `/`) is one of `files`, under exactly that path, or a
/// folder of the `owner`'s, writable by no one else, that holds one of them:
/// a tree of the installation's and nothing else. The path of the first
/// entry that is not.
pub fn only_listed(
    folder: &Fd,
    prefix: &str,
    files: &BTreeSet<String>,
    owner: u32,
) -> io::Result<Result<(), String>> {
    for name in sys::names(folder)? {
        let Ok(text) = std::str::from_utf8(name.to_bytes()) else {
            return Ok(Err(format!(
                "{prefix}{}",
                String::from_utf8_lossy(name.to_bytes())
            )));
        };
        let path = format!("{prefix}{text}");
        let Some(entry) = sys::entry_at(folder, &name)? else {
            continue;
        };
        let inside = format!("{path}/");
        match entry.kind {
            Kind::File if files.contains(&path) => {}
            Kind::Folder
                if is_ours(&entry, Kind::Folder, owner)
                    && files.iter().any(|file| file.starts_with(&inside)) =>
            {
                if let Err(at) =
                    only_listed(&sys::open_folder_at(folder, &name)?, &inside, files, owner)?
                {
                    return Ok(Err(at));
                }
            }
            _ => return Ok(Err(path)),
        }
    }
    Ok(Ok(()))
}

/// What a removal left under a folder.
#[derive(Debug, Default)]
pub struct Left {
    /// Entries kept, by relative path: not the installation's.
    pub kept: Vec<String>,
    /// Whether the folder was left empty.
    pub empty: bool,
}

/// Removes, under the open folder `folder` (at `prefix`, empty or ending
/// with `/`), each regular file that is one of `files` under exactly that
/// path, the release manifest at the top after the others, and each folder
/// of the installation's left empty. Anything else is kept. A folder on the
/// way to a listed file that is not as the installation makes it
/// (`is_ours`) cannot be looked into: its path is the error, and nothing
/// more is removed.
pub fn remove_listed(
    folder: &Fd,
    prefix: &str,
    files: &BTreeSet<String>,
    owner: u32,
) -> io::Result<Result<Left, String>> {
    let top = prefix.is_empty();
    let mut left = Left::default();
    let mut manifest = false;
    for name in sys::names(folder)? {
        let Ok(text) = std::str::from_utf8(name.to_bytes()) else {
            left.kept.push(format!(
                "{prefix}{}",
                String::from_utf8_lossy(name.to_bytes())
            ));
            continue;
        };
        let path = format!("{prefix}{text}");
        let Some(entry) = sys::entry_at(folder, &name)? else {
            continue;
        };
        let inside = format!("{path}/");
        match entry.kind {
            Kind::File if files.contains(&path) => {
                if top && path == MANIFEST {
                    manifest = true;
                } else {
                    sys::remove_at(folder, &name, false)?;
                }
            }
            Kind::Folder if files.iter().any(|file| file.starts_with(&inside)) => {
                if !is_ours(&entry, Kind::Folder, owner) {
                    return Ok(Err(path));
                }
                let inner = sys::open_folder_at(folder, &name)?;
                match remove_listed(&inner, &inside, files, owner)? {
                    Err(at) => return Ok(Err(at)),
                    Ok(inner_left) => {
                        left.kept.extend(inner_left.kept);
                        drop(inner);
                        if inner_left.empty {
                            crate::journal::remove_folder(folder, &name)?;
                        }
                    }
                }
            }
            _ => left.kept.push(path),
        }
    }
    if manifest {
        sys::remove_at(folder, &sys::c_name(MANIFEST.as_bytes())?, false)?;
    }
    sys::flush(folder.raw())?;
    left.empty = sys::names(folder)?.is_empty();
    Ok(Ok(left))
}

/// Every file under `root`, by relative path, sorted. Anything there that is
/// not a folder or a regular file is a conflict.
pub fn files(root: &Fd) -> Result<Vec<String>, WalkError> {
    let mut found = Vec::new();
    collect(root, "", &mut found)?;
    found.sort_unstable();
    Ok(found)
}

fn collect(folder: &Fd, prefix: &str, found: &mut Vec<String>) -> Result<(), WalkError> {
    for name in sys::names(folder)? {
        let text = String::from_utf8(name.to_bytes().to_vec()).map_err(|_| {
            WalkError::Conflict(format!(
                "{prefix}{}",
                String::from_utf8_lossy(name.to_bytes())
            ))
        })?;
        let path = format!("{prefix}{text}");
        match sys::entry_at(folder, &name)?.map(|entry| entry.kind) {
            Some(Kind::File) => found.push(path),
            Some(Kind::Folder) => {
                let inner = sys::open_folder_at(folder, &name)?;
                collect(&inner, &format!("{path}/"), found)?;
            }
            // Removed while it was read: what is left is walked.
            None => {}
            Some(_) => return Err(WalkError::Conflict(path)),
        }
    }
    Ok(())
}

/// The SHA-256 (lowercase hexadecimal) and size of what is left to read in `file`.
pub fn hash(file: &mut File) -> io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size += read as u64;
    }
    let digest = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok((digest, size))
}
