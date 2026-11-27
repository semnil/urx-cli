//! The journal of a work folder (K41 as revised). Every file and folder the
//! installer makes in the folder is made first under a reserved name, its
//! inode added to the journal and written through to the disk, and only then
//! moved to its path. What the journal names, and what is at a reserved
//! name, is the installation's, whatever it holds, a file cut short
//! included; nothing else in the folder is, whatever it holds.

use crate::place::is_ours;
use crate::records::{key, MANIFEST, RESERVED_PREFIX};
use crate::sys::{self, Entry, Fd, Kind};
use crate::tree::Left;
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::unix::io::AsRawFd;

/// The journal's name, at the top of the work folder. It goes with the
/// folder when the folder is put in place, and is removed from the root
/// before the installation is verified.
pub const JOURNAL: &str = ".urx-journal";

/// The longest journal read.
const LIMIT: u64 = 8 << 20;

/// The most reserved names one run tries.
const TRIES: u64 = 1 << 20;

/// Whether `name` is one maintenance keeps for itself (`.urx-`, in any
/// letter case), which no owned path holds.
pub fn is_reserved(name: &[u8]) -> bool {
    name.to_ascii_lowercase()
        .starts_with(RESERVED_PREFIX.as_bytes())
}

fn c(text: &str) -> CString {
    CString::new(text).unwrap_or_default()
}

fn invalid() -> io::Error {
    io::Error::from(io::ErrorKind::InvalidData)
}

/// The journal of a work folder being assembled.
pub struct Journal {
    file: File,
    volume: u64,
    next: u64,
    /// The folders it made, by inode: the only folders the release is
    /// written into.
    folders: BTreeSet<u64>,
}

impl Journal {
    /// Starts the journal in the work folder `work`, just made on `volume`.
    pub fn start(work: &Fd, volume: u64) -> io::Result<Journal> {
        let file = sys::create_file_at(work, &c(JOURNAL))?;
        sys::sync(file.as_raw_fd())?;
        sys::flush(work.raw())?;
        Ok(Journal {
            file,
            volume,
            next: 1,
            folders: BTreeSet::new(),
        })
    }

    fn reserved_name(&mut self) -> io::Result<CString> {
        if self.next > TRIES {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        let name = c(&format!("{RESERVED_PREFIX}new-{}", self.next));
        self.next += 1;
        Ok(name)
    }

    /// Adds `entry`'s inode and writes the journal through to the disk.
    fn record(&mut self, entry: &Entry) -> io::Result<u64> {
        if entry.id.0 != self.volume {
            return Err(invalid());
        }
        self.file
            .write_all(format!("{}\n", entry.id.1).as_bytes())?;
        sys::sync(self.file.as_raw_fd())?;
        Ok(entry.id.1)
    }

    /// A new file in the open folder `parent`, for writing, under a reserved
    /// name nothing was at, already in the journal; with that name, to move
    /// it to its path once written.
    pub fn new_file(&mut self, parent: &Fd) -> io::Result<(File, CString)> {
        loop {
            let name = self.reserved_name()?;
            match sys::create_file_at(parent, &name) {
                Ok(file) => {
                    self.record(&sys::entry(file.as_raw_fd())?)?;
                    return Ok((file, name));
                }
                Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    /// The new folder `name` in the open folder `parent` (0700): made under
    /// a reserved name, added to the journal, then moved to `name` where
    /// nothing is (an error with `EEXIST` otherwise).
    pub fn new_folder(&mut self, parent: &Fd, name: &CStr) -> io::Result<Fd> {
        loop {
            let reserved = self.reserved_name()?;
            match sys::make_folder_at(parent, &reserved, 0o700) {
                Ok(folder) => {
                    let inode = self.record(&sys::entry(folder.raw())?)?;
                    self.folders.insert(inode);
                    sys::rename_exclusive(parent, &reserved, name)?;
                    return Ok(folder);
                }
                Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    /// Whether this run made the folder `entry`.
    pub fn made(&self, entry: &Entry) -> bool {
        entry.id.0 == self.volume && self.folders.contains(&entry.id.1)
    }
}

/// What the journal in the open work folder names, by inode; None when there
/// is none. A line cut short by an interruption, the last, is left out; a
/// journal not the owner's regular file, or with any other line, is an
/// error.
pub fn read(work: &Fd, owner: u32) -> io::Result<Option<BTreeSet<u64>>> {
    let name = c(JOURNAL);
    if sys::entry_at(work, &name)?.is_none() {
        return Ok(None);
    }
    let (file, entry) = sys::open_file_at(work, &name)?;
    if !is_ours(&entry, Kind::File, owner) || entry.size > LIMIT {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| invalid())?;
    let mut lines: Vec<&str> = text.split('\n').collect();
    // What follows the last newline is a line not finished.
    lines.pop();
    let mut inodes = BTreeSet::new();
    for line in lines {
        if line.is_empty() || !line.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(invalid());
        }
        inodes.insert(line.parse::<u64>().map_err(|_| invalid())?);
    }
    Ok(Some(inodes))
}

/// Whether `path` is one of `files`, or a folder on the way to one, in any
/// letter case.
fn is_product_path(path: &str, files: &BTreeSet<String>) -> bool {
    let path = key(path);
    let inside = format!("{path}/");
    files.iter().any(|file| {
        let file = key(file);
        file == path || file.starts_with(&inside)
    })
}

/// Removes, under the open folder `folder` of a work folder (at `prefix`,
/// empty or ending with `/`), each entry that is the installation's: at a
/// reserved name, or (with `journal`) an object the journal names. Each such
/// folder must be as maintenance makes it; it is cleared first and removed
/// once empty. Anything else is kept, whatever it holds. With no journal,
/// anything else at a path of `files` (one of them, or a folder on the way
/// to one) cannot be told from the installation's: its path is the error.
/// The release manifest at the top goes after everything else, and the
/// journal is left for the caller.
pub fn clear(
    folder: &Fd,
    prefix: &str,
    journal: Option<&BTreeSet<u64>>,
    files: &BTreeSet<String>,
    owner: u32,
) -> io::Result<Result<Left, String>> {
    let top = prefix.is_empty();
    let mut left = Left::default();
    let mut manifest = false;
    for name in sys::names(folder)? {
        let bytes = name.to_bytes();
        if top && bytes == JOURNAL.as_bytes() {
            continue;
        }
        let path = format!("{prefix}{}", String::from_utf8_lossy(bytes));
        let Some(entry) = sys::entry_at(folder, &name)? else {
            continue;
        };
        let ours =
            is_reserved(bytes) || journal.is_some_and(|journal| journal.contains(&entry.id.1));
        if !ours {
            if journal.is_none() && is_product_path(&path, files) {
                return Ok(Err(path));
            }
            left.kept.push(path);
            continue;
        }
        if entry.kind != Kind::Folder {
            if top && bytes == MANIFEST.as_bytes() {
                manifest = true;
            } else {
                sys::remove_at(folder, &name, false)?;
            }
            continue;
        }
        if !is_ours(&entry, Kind::Folder, owner) {
            return Ok(Err(path));
        }
        let inner = sys::open_folder_at(folder, &name)?;
        let opened = sys::entry(inner.raw())?;
        if opened.id != entry.id || !is_ours(&opened, Kind::Folder, owner) {
            return Ok(Err(path));
        }
        match clear(&inner, &format!("{path}/"), journal, files, owner)? {
            Err(at) => return Ok(Err(at)),
            Ok(inner_left) => {
                left.kept.extend(inner_left.kept);
                drop(inner);
                if inner_left.empty {
                    remove_folder(folder, &name)?;
                }
            }
        }
    }
    if manifest {
        sys::remove_at(folder, &c(MANIFEST), false)?;
    }
    sys::flush(folder.raw())?;
    left.empty = sys::names(folder)?
        .iter()
        .all(|name| top && name.to_bytes() == JOURNAL.as_bytes());
    Ok(Ok(left))
}

/// Removes the folder `name` from `parent` while it is empty.
pub(crate) fn remove_folder(parent: &Fd, name: &CStr) -> io::Result<()> {
    match sys::remove_at(parent, name, true) {
        Ok(_) => Ok(()),
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
            ) =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

/// Removes the journal from the top of the open folder (a work folder, or
/// the root it became), the folder flushed; nothing when there is none. A
/// journal that is not the owner's regular file is an error.
pub fn remove(folder: &Fd, owner: u32) -> io::Result<()> {
    let name = c(JOURNAL);
    match sys::entry_at(folder, &name)? {
        None => Ok(()),
        Some(entry) if is_ours(&entry, Kind::File, owner) => {
            sys::remove_at(folder, &name, false)?;
            sys::flush(folder.raw())
        }
        Some(_) => Err(invalid()),
    }
}
