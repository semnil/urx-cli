//! Files under an open folder, reached by relative path one name at a time,
//! never through a link.

use crate::place::is_ours;
use crate::sys::{self, Fd, Kind};
use sha2::{Digest, Sha256};
use std::ffi::CString;
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

/// The open folder holding `path` (relative, `/`-separated) under `root`,
/// and the path's last name. Each folder on the way must be a folder, and
/// the `owner`'s writable by no one else when an owner is given. A missing
/// folder is made (0755) with `create`; otherwise the result is None.
pub fn parent_of(
    root: &Fd,
    path: &str,
    owner: Option<u32>,
    create: bool,
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
        let next = match sys::entry_at(parent, &name)? {
            None if create => sys::make_folder_at(parent, &name, 0o755)?,
            None => return Ok(None),
            Some(entry) => {
                let fits = match owner {
                    Some(owner) => is_ours(&entry, Kind::Folder, owner),
                    None => entry.kind == Kind::Folder,
                };
                if !fits {
                    return Err(WalkError::Conflict(walked));
                }
                sys::open_folder_at(parent, &name)?
            }
        };
        current = Some(next);
    }
    let parent = match current {
        Some(folder) => folder,
        // The root itself: a second descriptor of it.
        None => {
            // SAFETY: duplicates an open descriptor, owned by the new Fd.
            let fd = unsafe { libc::fcntl(root.raw(), libc::F_DUPFD_CLOEXEC, 0) };
            if fd < 0 {
                return Err(WalkError::Io(io::Error::last_os_error()));
            }
            sys::adopt(fd)
        }
    };
    Ok(Some((parent, sys::c_name(last.as_bytes())?)))
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
