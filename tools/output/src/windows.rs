//! Claiming and writing through held folders on Windows: the output and every
//! folder made in it are held open without delete sharing until the files are
//! written, so none of them can be renamed or removed meanwhile, and a path
//! under them names the folder this build made.

use crate::{random_suffix, Failure, Output};
use std::collections::BTreeSet;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, HANDLE,
};
use windows_sys::Win32::Storage::FileSystem::{
    FileRenameInfo, GetFileInformationByHandle, SetFileInformationByHandle,
    BY_HANDLE_FILE_INFORMATION, DELETE, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
    FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_LIST_DIRECTORY,
    FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE,
    SYNCHRONIZE,
};

const HOLD: u32 = FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;

/// Opens the folder at `path` without following a reparse point, sharing
/// reads and writes but not deletion, so nobody can rename or remove it, or a
/// folder above it, while the handle is open.
fn hold(path: &Path, access: u32) -> io::Result<File> {
    OpenOptions::new()
        .access_mode(access)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)
}

fn information(file: &File) -> io::Result<BY_HANDLE_FILE_INFORMATION> {
    // SAFETY: an all-zero record is valid for the call to fill.
    let mut found: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    // SAFETY: the handle is open and `found` is writable.
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as HANDLE, &mut found) } == 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(found)
}

fn is_plain_folder(found: &BY_HANDLE_FILE_INFORMATION) -> bool {
    found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0
        && found.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT == 0
}

/// The identity of a folder: its volume and file index.
fn identity(found: &BY_HANDLE_FILE_INFORMATION) -> String {
    format!(
        "{}:{}:{}",
        found.dwVolumeSerialNumber, found.nFileIndexHigh, found.nFileIndexLow
    )
}

fn is_empty(path: &Path) -> io::Result<bool> {
    Ok(std::fs::read_dir(path)?.next().is_none())
}

/// Renames the folder `held` is open on to `to`, unless anything is there.
fn rename_held(held: &File, to: &Path) -> Result<(), u32> {
    let name: Vec<u16> = to.as_os_str().encode_wide().collect();
    let offset = std::mem::offset_of!(FILE_RENAME_INFO, FileName);
    let size = offset + (name.len() + 1) * std::mem::size_of::<u16>();
    // Aligned for the record, zeroed so the name ends with a NUL.
    let mut buffer = vec![0u64; size.div_ceil(std::mem::size_of::<u64>())];
    let record = buffer.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    // SAFETY: `buffer` is large enough and aligned for the record and the name that follows it.
    unsafe {
        (*record).Anonymous.ReplaceIfExists = false;
        (*record).RootDirectory = std::ptr::null_mut();
        (*record).FileNameLength = (name.len() * std::mem::size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            std::ptr::addr_of_mut!((*record).FileName).cast::<u16>(),
            name.len(),
        );
    }
    // SAFETY: the handle is open with delete access and `record` spans `size` bytes.
    let renamed = unsafe {
        SetFileInformationByHandle(
            held.as_raw_handle() as HANDLE,
            FileRenameInfo,
            record.cast(),
            size as u32,
        )
    };
    if renamed == 0 {
        // SAFETY: reads the calling thread's last error.
        return Err(unsafe { GetLastError() });
    }
    Ok(())
}

/// Claims `output`: an empty folder made under a random name beside it, held,
/// then renamed through that handle to `output` only where nothing is.
/// Returns the folder's identity.
pub fn claim(output: &Path) -> Result<String, Failure> {
    let output = std::path::absolute(output)?;
    let parent = output
        .parent()
        .ok_or_else(|| Failure::other(format!("{} names no folder", output.display())))?;
    let name = output
        .file_name()
        .ok_or_else(|| Failure::other(format!("{} names no folder", output.display())))?;
    match std::fs::symlink_metadata(&output) {
        Ok(_) => return Err(Failure::exists(&output)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(Failure::other(format!(
                "{} could not be examined: {error}",
                output.display()
            )))
        }
    }
    let mut made = None;
    for _ in 0..16 {
        let candidate = parent.join(format!(
            ".{}.claim-{:016x}",
            name.to_string_lossy(),
            random_suffix()
        ));
        match std::fs::create_dir(&candidate) {
            Ok(()) => {
                made = Some(candidate);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    let temporary = made.ok_or_else(|| Failure::other("no unused name was found for the claim"))?;
    let held = hold(&temporary, HOLD | DELETE)?;
    let found = information(&held)?;
    if !is_plain_folder(&found) || !is_empty(&temporary)? {
        return Err(Failure::other(
            "the folder made for the claim is not an empty folder",
        ));
    }
    if let Err(code) = rename_held(&held, &output) {
        drop(held);
        // Only an empty folder can go, and the name is this run's own.
        let _ = std::fs::remove_dir(&temporary);
        return Err(
            if code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS {
                Failure::exists(&output)
            } else {
                Failure::other(format!(
                    "{} could not be claimed: {}",
                    output.display(),
                    io::Error::from_raw_os_error(code as i32)
                ))
            },
        );
    }
    Ok(identity(&found))
}

/// The claimed output and every folder this build made in it, all held.
struct Held {
    root: PathBuf,
    /// Kept open, not read: holding them is what keeps the folders in place.
    _holds: Vec<File>,
}

impl Held {
    fn at(&self, path: &[String]) -> PathBuf {
        let mut at = self.root.clone();
        for name in path {
            at.push(name);
        }
        at
    }
}

impl Output for Held {
    fn make_folder(&mut self, path: &[String]) -> io::Result<()> {
        let at = self.at(path);
        std::fs::create_dir(&at)?;
        let folder = hold(&at, HOLD)?;
        if !is_plain_folder(&information(&folder)?) || !is_empty(&at)? {
            return Err(io::Error::other("it is not the empty folder just made"));
        }
        self._holds.push(folder);
        Ok(())
    }

    fn write_file(&mut self, path: &[String], bytes: &[u8], _mode: u32) -> io::Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(self.at(path))?;
        file.write_all(bytes)
    }

    fn set_folder_mode(&mut self, _path: &[String], _mode: u32) -> io::Result<()> {
        Ok(())
    }

    fn files(&mut self) -> io::Result<BTreeSet<String>> {
        fn walk(directory: &Path, prefix: &str, found: &mut BTreeSet<String>) -> io::Result<()> {
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                // The entry's own metadata: a reparse point is not followed.
                let metadata = entry.metadata()?;
                let name = entry.file_name();
                let text = name
                    .to_str()
                    .ok_or_else(|| io::Error::other("a name in the output is not UTF-8"))?;
                let path = if prefix.is_empty() {
                    text.to_owned()
                } else {
                    format!("{prefix}/{text}")
                };
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    return Err(io::Error::other(format!(
                        "{path} is a link or another reparse point"
                    )));
                }
                if metadata.is_dir() {
                    walk(&entry.path(), &path, found)?;
                } else if metadata.is_file() {
                    found.insert(path);
                } else {
                    return Err(io::Error::other(format!(
                        "{path} is neither a regular file nor a folder"
                    )));
                }
            }
            Ok(())
        }
        let mut found = BTreeSet::new();
        walk(&self.root, "", &mut found)?;
        Ok(found)
    }
}

/// Holds `output` without following a reparse point, when it is the folder `claimed` names.
pub fn open(output: &Path, claimed: &str) -> Result<Box<dyn Output>, Failure> {
    let root = std::path::absolute(output)?;
    let held = hold(&root, HOLD).map_err(|_| Failure::not_claimed(output))?;
    let found = information(&held)?;
    if !is_plain_folder(&found) || identity(&found) != claimed {
        return Err(Failure::not_claimed(output));
    }
    Ok(Box::new(Held {
        root,
        _holds: vec![held],
    }))
}
