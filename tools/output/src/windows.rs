//! The work folder on Windows. The work folder and every folder made in it
//! are held open without delete sharing while the files are written, so none
//! of them can be renamed or removed meanwhile and a path under them names a
//! folder this build made; the walk opens each folder by path and checks it
//! against the one made; the work folder is renamed to the output through its
//! own handle, with no replacing.

use crate::{random_suffix, same_contents, Failure, Found, Work};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
use std::os::windows::io::AsRawHandle;
use std::path::{Path, PathBuf};
use windows_sys::Win32::Foundation::{
    GetLastError, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, GENERIC_WRITE, HANDLE,
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
/// reads and writes but not deletion, so nobody can rename or remove it while
/// the handle is open.
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
fn identity(found: &BY_HANDLE_FILE_INFORMATION) -> (u32, u32, u32) {
    (
        found.dwVolumeSerialNumber,
        found.nFileIndexHigh,
        found.nFileIndexLow,
    )
}

fn is_empty(path: &Path) -> io::Result<bool> {
    Ok(std::fs::read_dir(path)?.next().is_none())
}

/// Renames the file or folder `held` is open on to `to`, unless anything is there.
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

/// The work folder beside the output, held, with the folders made in it.
struct WinWork {
    output: PathBuf,
    root: PathBuf,
    /// The work folder, held with delete access for its own rename.
    held: File,
    /// The identity of every folder made, the work folder's own under `[]`.
    made: BTreeMap<Vec<String>, (u32, u32, u32)>,
    /// Kept open while the files are written: holding them keeps the folders in place.
    pins: Vec<File>,
}

/// Makes the work folder for `output`, beside it under a random name, when
/// nothing is at `output`.
pub fn create_work(output: &Path) -> Result<Box<dyn Work>, Failure> {
    let output = std::path::absolute(output)?;
    let parent = output
        .parent()
        .ok_or_else(|| Failure::other(format!("{} names no folder", output.display())))?;
    let base = output
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
    for _ in 0..16 {
        let root = parent.join(format!(
            "{}.work-{:016x}",
            base.to_string_lossy(),
            random_suffix()
        ));
        match std::fs::create_dir(&root) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
        let held = hold(&root, HOLD | DELETE)?;
        let found = information(&held)?;
        if !is_plain_folder(&found) || !is_empty(&root)? {
            return Err(Failure::other(
                "the work folder just made is not an empty folder",
            ));
        }
        let mut made = BTreeMap::new();
        made.insert(Vec::new(), identity(&found));
        return Ok(Box::new(WinWork {
            output,
            root,
            held,
            made,
            pins: Vec::new(),
        }));
    }
    Err(Failure::other(
        "no unused name was found for the work folder",
    ))
}

impl WinWork {
    fn at(&self, path: &[String]) -> PathBuf {
        let mut at = self.root.clone();
        for name in path {
            at.push(name);
        }
        at
    }
}

impl Work for WinWork {
    fn path(&self) -> &Path {
        &self.root
    }

    fn make_folder(&mut self, path: &[String]) -> io::Result<()> {
        let at = self.at(path);
        std::fs::create_dir(&at)?;
        let folder = hold(&at, HOLD)?;
        let found = information(&folder)?;
        if !is_plain_folder(&found) || !is_empty(&at)? {
            return Err(io::Error::other("it is not the empty folder just made"));
        }
        self.made.insert(path.to_vec(), identity(&found));
        self.pins.push(folder);
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

    fn walk(&mut self, expected: &BTreeMap<String, PathBuf>) -> io::Result<Found> {
        fn visit(
            work: &WinWork,
            directory: &Path,
            prefix: &[String],
            expected: &BTreeMap<String, PathBuf>,
            found: &mut Found,
        ) -> io::Result<()> {
            for entry in std::fs::read_dir(directory)? {
                let entry = entry?;
                // The entry's own metadata: a reparse point is not followed.
                let metadata = entry.metadata()?;
                let name = entry.file_name();
                let text = name
                    .to_str()
                    .ok_or_else(|| io::Error::other("a name in the output is not UTF-8"))?;
                let mut path = prefix.to_vec();
                path.push(text.to_owned());
                let joined = path.join("/");
                if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                    found.others.push(joined);
                } else if metadata.is_dir() {
                    let opened = hold(&entry.path(), HOLD)?;
                    let same = work.made.get(&path) == Some(&identity(&information(&opened)?));
                    if same {
                        visit(work, &entry.path(), &path, expected, found)?;
                    } else {
                        found.replaced.push(joined);
                    }
                } else if metadata.is_file() {
                    if let Some(source) = expected.get(&joined) {
                        let mut written = OpenOptions::new()
                            .read(true)
                            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                            .open(entry.path())?;
                        if !same_contents(&mut written, &mut File::open(source)?)? {
                            found.changed.push(joined.clone());
                        }
                    }
                    found.files.insert(joined);
                } else {
                    found.others.push(joined);
                }
            }
            Ok(())
        }
        let mut found = Found::default();
        visit(self, &self.root, &[], expected, &mut found)?;
        Ok(found)
    }

    fn write_record(&mut self, name: &str, bytes: &[u8], _mode: u32) -> io::Result<()> {
        let temporary = self
            .root
            .join(format!(".{name}.part-{:016x}", random_suffix()));
        let mut file = OpenOptions::new()
            .write(true)
            .access_mode(GENERIC_WRITE | DELETE)
            .create_new(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(&temporary)?;
        let written = file.write_all(bytes).and_then(|()| {
            rename_held(&file, &self.root.join(name))
                .map_err(|code| io::Error::from_raw_os_error(code as i32))
        });
        if written.is_err() {
            drop(file);
            // The temporary file is this build's own, in its own work folder.
            let _ = std::fs::remove_file(&temporary);
        }
        written
    }

    fn remove_record(&mut self, name: &str) {
        // The work folder is still held here, so the path names this build's own record.
        let _ = std::fs::remove_file(self.root.join(name));
    }

    fn publish(&mut self) -> Result<(), Failure> {
        // The folders inside are let go, so the work folder itself can be renamed.
        self.pins.clear();
        rename_held(&self.held, &self.output).map_err(|code| {
            if code == ERROR_ALREADY_EXISTS || code == ERROR_FILE_EXISTS {
                Failure::exists(&self.output)
            } else {
                Failure::other(format!(
                    "{} could not be published: {}",
                    self.output.display(),
                    io::Error::from_raw_os_error(code as i32)
                ))
            }
        })
    }
}
