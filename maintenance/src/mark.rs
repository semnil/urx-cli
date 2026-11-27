//! The marks on what the installer makes in a work folder (K41 as revised).
//! Every file and folder it makes there is made first under a reserved name,
//! given the extended attribute `MARK` holding the work folder's inode, and
//! written through to the disk, and only then moved to its path. What
//! carries the mark of the work folder it is in, and what is at a reserved
//! name, is the installation's, whatever it holds, a file cut short
//! included; nothing else is, whatever it holds. Each object carries its own
//! mark, so no list of them can be cut short or lost. Installed files keep
//! the mark; nothing reads it outside a work folder.

use crate::place::is_ours;
use crate::records::{MANIFEST, RESERVED_PREFIX};
use crate::sys::{self, Entry, Fd, Kind};
use crate::tree::Left;
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::unix::io::AsRawFd;

/// The extended attribute that marks what the installer made.
pub const MARK: &str = "urx-cli.made";

/// The longest mark read.
const MARK_LIMIT: usize = 32;

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

/// Makes the entries of the work folder whose inode is `work`, each marked.
pub struct Maker {
    work: u64,
    volume: u64,
    next: u64,
    /// The folders it made, by inode: the only folders the release is
    /// written into.
    folders: std::collections::BTreeSet<u64>,
}

impl Maker {
    /// The maker of the work folder `work`, on `volume`.
    pub fn new(work: u64, volume: u64) -> Maker {
        Maker {
            work,
            volume,
            next: 1,
            folders: Default::default(),
        }
    }

    fn reserved_name(&mut self) -> io::Result<CString> {
        if self.next > TRIES {
            return Err(io::Error::from(io::ErrorKind::AlreadyExists));
        }
        let name = c(&format!("{RESERVED_PREFIX}new-{}", self.next));
        self.next += 1;
        Ok(name)
    }

    fn mark(&self, fd: libc::c_int) -> io::Result<()> {
        if sys::entry(fd)?.id.0 != self.volume {
            return Err(io::Error::from(io::ErrorKind::InvalidData));
        }
        sys::set_mark(fd, &c(MARK), self.work.to_string().as_bytes())
    }

    /// A new file in the open folder `parent`, for writing, under a reserved
    /// name nothing was at, already marked; with that name. The caller
    /// writes it through to the disk (`sys::sync`) before moving it to its
    /// path, so that its mark is there wherever it is found.
    pub fn new_file(&mut self, parent: &Fd) -> io::Result<(File, CString)> {
        loop {
            let name = self.reserved_name()?;
            match sys::create_file_at(parent, &name) {
                Ok(file) => {
                    self.mark(file.as_raw_fd())?;
                    return Ok((file, name));
                }
                Err(error) if error.raw_os_error() == Some(libc::EEXIST) => continue,
                Err(error) => return Err(error),
            }
        }
    }

    /// The new folder `name` in the open folder `parent` (0700): made under
    /// a reserved name, marked, written through, then moved to `name` where
    /// nothing is (an error with `EEXIST` otherwise).
    pub fn new_folder(&mut self, parent: &Fd, name: &CStr) -> io::Result<Fd> {
        loop {
            let reserved = self.reserved_name()?;
            match sys::make_folder_at(parent, &reserved, 0o700) {
                Ok(folder) => {
                    self.mark(folder.raw())?;
                    sys::sync(folder.raw())?;
                    self.folders.insert(sys::entry(folder.raw())?.id.1);
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

/// Whether the open object `fd` carries the mark of the work folder `work`.
fn carries(fd: libc::c_int, work: u64) -> io::Result<bool> {
    Ok(sys::mark_of(fd, &c(MARK), MARK_LIMIT)?
        .is_some_and(|value| value == work.to_string().as_bytes()))
}

/// Removes, under the open folder `folder` of the work folder `work` (at
/// `prefix`, empty or ending with `/`), each entry that is the
/// installation's: at a reserved name, or carrying the work folder's mark.
/// Each such folder must be as maintenance makes it; it is cleared first and
/// removed once empty. Anything else is kept, whatever it holds. An entry
/// whose mark cannot be read cannot be told from the installation's: its
/// path is the error, as is that of a folder of the installation's not as
/// maintenance makes it. The release manifest at the top goes after
/// everything else.
pub fn clear(folder: &Fd, prefix: &str, work: u64, owner: u32) -> io::Result<Result<Left, String>> {
    let top = prefix.is_empty();
    let mut left = Left::default();
    let mut manifest = false;
    for name in sys::names(folder)? {
        let bytes = name.to_bytes();
        let path = format!("{prefix}{}", String::from_utf8_lossy(bytes));
        let Some(entry) = sys::entry_at(folder, &name)? else {
            continue;
        };
        let reserved = is_reserved(bytes);
        match entry.kind {
            Kind::Folder => {
                let Ok(inner) = sys::open_folder_at(folder, &name) else {
                    return Ok(Err(path));
                };
                let opened = sys::entry(inner.raw())?;
                if opened.id != entry.id {
                    return Ok(Err(path));
                }
                let Ok(marked) = carries(inner.raw(), work) else {
                    return Ok(Err(path));
                };
                if !reserved && !marked {
                    left.kept.push(path);
                    continue;
                }
                if !is_ours(&opened, Kind::Folder, owner) {
                    return Ok(Err(path));
                }
                match clear(&inner, &format!("{path}/"), work, owner)? {
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
            Kind::File => {
                let marked = match sys::open_file_at(folder, &name) {
                    Ok((file, opened)) if opened.id == entry.id => {
                        match carries(file.as_raw_fd(), work) {
                            Ok(marked) => marked,
                            Err(_) => return Ok(Err(path)),
                        }
                    }
                    _ => return Ok(Err(path)),
                };
                if !reserved && !marked {
                    left.kept.push(path);
                } else if top && bytes == MANIFEST.as_bytes() {
                    manifest = true;
                } else {
                    sys::remove_at(folder, &name, false)?;
                }
            }
            // Never made by the installer: only at a reserved name is it the installation's.
            _ if reserved => {
                sys::remove_at(folder, &name, false)?;
            }
            _ => left.kept.push(path),
        }
    }
    if manifest {
        sys::remove_at(folder, &c(MANIFEST), false)?;
    }
    sys::flush(folder.raw())?;
    left.empty = sys::names(folder)?.is_empty();
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
