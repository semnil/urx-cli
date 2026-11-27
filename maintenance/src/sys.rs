//! File operations relative to open folders. Every entry under a fixed path
//! is reached by name from its open parent, without following a link, so a
//! link put in place of a folder or a file is never followed into another
//! tree.

use std::ffi::{CStr, CString};
use std::fs::File;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::Path;

/// An open descriptor, closed when dropped.
#[derive(Debug)]
pub struct Fd(libc::c_int);

impl Fd {
    pub fn raw(&self) -> libc::c_int {
        self.0
    }
}

/// Takes ownership of the open descriptor `fd`.
pub fn adopt(fd: libc::c_int) -> Fd {
    Fd(fd)
}

impl Drop for Fd {
    fn drop(&mut self) {
        // SAFETY: the descriptor is owned here and closed once.
        unsafe { libc::close(self.0) };
    }
}

fn checked(result: libc::c_int) -> io::Result<libc::c_int> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(result)
    }
}

/// `bytes` as a C string; a NUL in it is refused.
pub fn c_name(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::other("a name holds a NUL"))
}

const FOLDER_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

/// What an entry is, as `lstat` sees it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    File,
    Folder,
    Link,
    Other,
}

/// An entry's type, owner and permission bits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Entry {
    pub kind: Kind,
    pub owner: u32,
    pub mode: u32,
    pub size: u64,
}

fn entry_of(found: &libc::stat) -> Entry {
    let kind = match found.st_mode & libc::S_IFMT {
        libc::S_IFREG => Kind::File,
        libc::S_IFDIR => Kind::Folder,
        libc::S_IFLNK => Kind::Link,
        _ => Kind::Other,
    };
    Entry {
        kind,
        owner: found.st_uid,
        mode: u32::from(found.st_mode) & 0o7777,
        size: found.st_size as u64,
    }
}

/// The open descriptor's entry.
pub fn entry(fd: libc::c_int) -> io::Result<Entry> {
    // SAFETY: an all-zero stat is valid for the call to fill.
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` is open and `found` is writable.
    checked(unsafe { libc::fstat(fd, &mut found) })?;
    Ok(entry_of(&found))
}

/// What is at `name` in the open folder `parent`, not following a link, or
/// None when nothing is.
pub fn entry_at(parent: &Fd, name: &CStr) -> io::Result<Option<Entry>> {
    // SAFETY: an all-zero stat is valid for the call to fill.
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated and `found` is writable.
    if unsafe {
        libc::fstatat(
            parent.0,
            name.as_ptr(),
            &mut found,
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } == 0
    {
        return Ok(Some(entry_of(&found)));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(None)
    } else {
        Err(error)
    }
}

/// Opens the folder at the absolute `path`, following links in it as the
/// system does: the fixed parents (`/usr/local/lib`, `/usr/local/bin`,
/// `/Library/Application Support`) are the system's.
pub fn open_system_folder(path: &Path) -> io::Result<Fd> {
    let path = c_name(path.as_os_str().as_bytes())?;
    // SAFETY: `path` is NUL-terminated; the flags open a folder read-only.
    let fd = checked(unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    })?;
    Ok(Fd(fd))
}

/// Opens the folder `name` in the open folder `parent`, not following a link.
pub fn open_folder_at(parent: &Fd, name: &CStr) -> io::Result<Fd> {
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
    let fd = checked(unsafe { libc::openat(parent.0, name.as_ptr(), FOLDER_FLAGS) })?;
    Ok(Fd(fd))
}

/// Makes the folder `name` in the open folder `parent` with `mode`, whatever
/// the umask, and opens it.
pub fn make_folder_at(parent: &Fd, name: &CStr, mode: u32) -> io::Result<Fd> {
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
    checked(unsafe { libc::mkdirat(parent.0, name.as_ptr(), 0o700) })?;
    let folder = open_folder_at(parent, name)?;
    // SAFETY: `folder` is open.
    checked(unsafe { libc::fchmod(folder.0, mode as libc::mode_t) })?;
    Ok(folder)
}

/// Opens the regular file `name` in the open folder `parent` for reading,
/// not following a link and not waiting (a FIFO in its place has no writer
/// to wait for); anything but a regular file is refused.
pub fn open_file_at(parent: &Fd, name: &CStr) -> io::Result<(File, Entry)> {
    let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC;
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
    let fd = checked(unsafe { libc::openat(parent.0, name.as_ptr(), flags) })?;
    // SAFETY: `fd` was just opened and is owned by the file from here.
    let file = unsafe { File::from_raw_fd(fd) };
    let found = entry(file.as_raw_fd())?;
    if found.kind != Kind::File {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    Ok((file, found))
}

/// Creates the file `name` where nothing is in the open folder `parent`,
/// for writing.
pub fn create_file_at(parent: &Fd, name: &CStr) -> io::Result<File> {
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder; the file is created where nothing is.
    let fd =
        checked(unsafe { libc::openat(parent.0, name.as_ptr(), flags, 0o600 as libc::c_uint) })?;
    // SAFETY: `fd` was just opened and is owned by the file from here.
    Ok(unsafe { File::from_raw_fd(fd) })
}

/// Gives the open file `file` the permission bits `mode`.
pub fn set_mode(file: &File, mode: u32) -> io::Result<()> {
    // SAFETY: `file` is open.
    checked(unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) })?;
    Ok(())
}

/// Removes the entry `name` (a folder when `folder`) from the open folder
/// `parent`, not following a link; false when nothing was there.
pub fn remove_at(parent: &Fd, name: &CStr, folder: bool) -> io::Result<bool> {
    let flags = if folder { libc::AT_REMOVEDIR } else { 0 };
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
    if unsafe { libc::unlinkat(parent.0, name.as_ptr(), flags) } == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(false)
    } else {
        Err(error)
    }
}

/// Renames `from` to `to`, both in the open folder `parent`, replacing what
/// is at `to` (a file or a link, never followed).
pub fn rename_at(parent: &Fd, from: &CStr, to: &CStr) -> io::Result<()> {
    // SAFETY: both names are NUL-terminated and `parent` is an open folder.
    checked(unsafe { libc::renameat(parent.0, from.as_ptr(), parent.0, to.as_ptr()) })?;
    Ok(())
}

/// The target of the link `name` in the open folder `parent`.
pub fn link_target_at(parent: &Fd, name: &CStr) -> io::Result<Vec<u8>> {
    let mut buffer = vec![0u8; libc::PATH_MAX as usize + 1];
    // SAFETY: `name` is NUL-terminated and `buffer` is writable for its length.
    let length = unsafe {
        libc::readlinkat(
            parent.0,
            name.as_ptr(),
            buffer.as_mut_ptr() as *mut libc::c_char,
            buffer.len(),
        )
    };
    if length < 0 {
        return Err(io::Error::last_os_error());
    }
    buffer.truncate(length as usize);
    Ok(buffer)
}

/// Makes the link `name` to `target` where nothing is in the open folder `parent`.
pub fn make_link_at(parent: &Fd, name: &CStr, target: &CStr) -> io::Result<()> {
    // SAFETY: both strings are NUL-terminated and `parent` is an open folder.
    checked(unsafe { libc::symlinkat(target.as_ptr(), parent.0, name.as_ptr()) })?;
    Ok(())
}

/// Hands what the open descriptor holds to the disk (`fsync`). The drive
/// may still hold it in its cache until a `sync` on that disk.
pub fn flush(fd: libc::c_int) -> io::Result<()> {
    // SAFETY: `fd` is open.
    checked(unsafe { libc::fsync(fd) })?;
    Ok(())
}

/// Writes what the open descriptor holds through to the disk: `fsync`, then
/// on macOS `F_FULLFSYNC`, which also empties the drive's cache, and with it
/// what earlier flushes on that disk handed over. A file system without
/// `F_FULLFSYNC` has had its `fsync`.
pub fn sync(fd: libc::c_int) -> io::Result<()> {
    flush(fd)?;
    #[cfg(target_os = "macos")]
    {
        // SAFETY: `fd` is open; F_FULLFSYNC takes no argument.
        if unsafe { libc::fcntl(fd, libc::F_FULLFSYNC) } < 0 {
            let error = io::Error::last_os_error();
            if !matches!(
                error.raw_os_error(),
                Some(libc::ENOTSUP) | Some(libc::ENOTTY) | Some(libc::EINVAL)
            ) {
                return Err(error);
            }
        }
    }
    Ok(())
}

/// The names in the open folder, `.` and `..` left out.
pub fn names(folder: &Fd) -> io::Result<Vec<CString>> {
    // SAFETY: duplicates an open descriptor for the directory stream to own.
    let copy = checked(unsafe { libc::dup(folder.0) })?;
    // SAFETY: `copy` is an open folder; the stream owns it from here.
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        // SAFETY: `copy` was not taken by a stream.
        unsafe { libc::close(copy) };
        return Err(error);
    }
    // The copy shares its offset with `folder`: start from the first entry.
    // SAFETY: `stream` is open.
    unsafe { libc::rewinddir(stream) };
    let mut found = Vec::new();
    let result = loop {
        set_errno(0);
        // SAFETY: `stream` is open.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
            break if errno == 0 {
                Ok(())
            } else {
                Err(io::Error::from_raw_os_error(errno))
            };
        }
        // SAFETY: `entry` points to a valid entry with a NUL-terminated name until the next call.
        let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            found.push(name.to_owned());
        }
    };
    // SAFETY: `stream` is open and closed once, with the copy it owns.
    unsafe { libc::closedir(stream) };
    result.map(|()| found)
}

#[cfg(target_os = "macos")]
fn set_errno(value: libc::c_int) {
    // SAFETY: sets this thread's errno.
    unsafe { *libc::__error() = value };
}

#[cfg(not(target_os = "macos"))]
fn set_errno(value: libc::c_int) {
    // SAFETY: sets this thread's errno.
    unsafe { *libc::__errno_location() = value };
}

/// The effective user of this process.
pub fn effective_user() -> u32 {
    // SAFETY: geteuid has no preconditions.
    unsafe { libc::geteuid() }
}
