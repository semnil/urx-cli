//! Claiming and writing through open folders on macOS: every folder and file
//! is made relative to its open parent, so renaming or replacing a path while
//! the build runs cannot send a write anywhere else.

use crate::{random_suffix, Failure, Output};
use std::collections::{BTreeSet, HashMap};
use std::ffi::{CStr, CString, OsStr};
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::Path;

/// An open descriptor, closed when dropped.
struct Fd(libc::c_int);

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

fn c_name(bytes: &[u8]) -> io::Result<CString> {
    CString::new(bytes).map_err(|_| io::Error::other("a name holds a NUL"))
}

const FOLDER_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;

/// Opens the folder `name` in the open folder `parent`, not following a link.
fn open_folder_at(parent: libc::c_int, name: &CStr) -> io::Result<Fd> {
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
    let fd = checked(unsafe { libc::openat(parent, name.as_ptr(), FOLDER_FLAGS) })?;
    Ok(Fd(fd))
}

fn status(fd: libc::c_int) -> io::Result<libc::stat> {
    // SAFETY: an all-zero stat is valid for the call to fill.
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `fd` is open and `found` is writable.
    checked(unsafe { libc::fstat(fd, &mut found) })?;
    Ok(found)
}

/// The identity of a folder: its device, inode and birth time, so a folder
/// made later under a reused inode does not pass for it.
fn identity(found: &libc::stat) -> String {
    format!(
        "{}:{}:{}:{}",
        found.st_dev, found.st_ino, found.st_birthtime, found.st_birthtime_nsec
    )
}

/// The names in the open folder `fd`, `.` and `..` left out.
fn names(fd: libc::c_int) -> io::Result<Vec<CString>> {
    // SAFETY: duplicates an open descriptor for the directory stream to own.
    let copy = checked(unsafe { libc::dup(fd) })?;
    // SAFETY: `copy` is an open folder; the stream owns it from here.
    let stream = unsafe { libc::fdopendir(copy) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        // SAFETY: `copy` was not taken by a stream.
        unsafe { libc::close(copy) };
        return Err(error);
    }
    // The copy shares its offset with `fd`: start from the first entry.
    // SAFETY: `stream` is open.
    unsafe { libc::rewinddir(stream) };
    let mut found = Vec::new();
    let result = loop {
        // SAFETY: clears this thread's errno, to tell the end from an error.
        unsafe { *libc::__error() = 0 };
        // SAFETY: `stream` is open.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() {
            // SAFETY: reads this thread's errno.
            let errno = unsafe { *libc::__error() };
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

/// Whether anything, a link included, is at `name` in the open folder `parent`.
fn something_at(parent: libc::c_int, name: &CStr) -> io::Result<bool> {
    // SAFETY: an all-zero stat is valid for the call to fill.
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated and `found` is writable.
    let result =
        unsafe { libc::fstatat(parent, name.as_ptr(), &mut found, libc::AT_SYMLINK_NOFOLLOW) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(false)
    } else {
        Err(error)
    }
}

/// Makes an empty folder under a random name in `parent`, opened.
fn make_temporary(parent: libc::c_int, name: &OsStr) -> io::Result<(CString, Fd)> {
    for _ in 0..16 {
        let candidate = c_name(
            format!(".{}.claim-{:016x}", name.to_string_lossy(), random_suffix()).as_bytes(),
        )?;
        // SAFETY: `candidate` is NUL-terminated and `parent` is an open folder.
        if let Err(error) = checked(unsafe { libc::mkdirat(parent, candidate.as_ptr(), 0o700) }) {
            if error.raw_os_error() == Some(libc::EEXIST) {
                continue;
            }
            return Err(error);
        }
        let folder = open_folder_at(parent, &candidate)?;
        if !names(folder.0)?.is_empty() {
            return Err(io::Error::other(
                "the folder made for the claim is not empty",
            ));
        }
        return Ok((candidate, folder));
    }
    Err(io::Error::other("no unused name was found for the claim"))
}

/// Claims `output`: an empty folder made under a random name beside it, then
/// renamed to it only where nothing is. Returns the folder's identity.
pub fn claim(output: &Path) -> Result<String, Failure> {
    let parent = match output.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let name = output
        .file_name()
        .ok_or_else(|| Failure::other(format!("{} names no folder", output.display())))?;
    let parent_name = c_name(parent.as_os_str().as_bytes())?;
    // SAFETY: `parent_name` is NUL-terminated.
    let parent_fd = Fd(checked(unsafe {
        libc::open(
            parent_name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
        )
    })?);
    let target = c_name(name.as_bytes())?;
    if something_at(parent_fd.0, &target)? {
        return Err(Failure::exists(output));
    }
    let (temporary, folder) = make_temporary(parent_fd.0, name)?;
    let claimed = identity(&status(folder.0)?);
    // SAFETY: both names are NUL-terminated in the open folder `parent_fd`.
    let renamed = unsafe {
        libc::renameatx_np(
            parent_fd.0,
            temporary.as_ptr(),
            parent_fd.0,
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if renamed < 0 {
        let error = io::Error::last_os_error();
        // Only an empty folder can go, and the name is this run's own.
        // SAFETY: `temporary` is NUL-terminated in the open folder `parent_fd`.
        unsafe { libc::unlinkat(parent_fd.0, temporary.as_ptr(), libc::AT_REMOVEDIR) };
        return Err(if error.raw_os_error() == Some(libc::EEXIST) {
            Failure::exists(output)
        } else {
            Failure::other(format!(
                "{} could not be claimed: {error}",
                output.display()
            ))
        });
    }
    Ok(claimed)
}

/// The claimed output, with the folders this build made in it, all open.
struct Opened {
    path: std::path::PathBuf,
    claimed: String,
    folders: HashMap<Vec<String>, Fd>,
}

/// Opens `output` without following a link, as a folder.
fn open_path(output: &Path) -> io::Result<Fd> {
    let name = c_name(output.as_os_str().as_bytes())?;
    // SAFETY: `name` is NUL-terminated.
    Ok(Fd(checked(unsafe {
        libc::open(name.as_ptr(), FOLDER_FLAGS)
    })?))
}

impl Opened {
    /// The open folder that holds `path`, and `path`'s own name.
    fn parent_of(&self, path: &[String]) -> io::Result<(libc::c_int, CString)> {
        let (name, parent) = path
            .split_last()
            .ok_or_else(|| io::Error::other("an empty path"))?;
        let folder = self
            .folders
            .get(parent)
            .ok_or_else(|| io::Error::other("its folder was not made by this build"))?;
        Ok((folder.0, c_name(name.as_bytes())?))
    }
}

impl Output for Opened {
    fn make_folder(&mut self, path: &[String]) -> io::Result<()> {
        let (parent, name) = self.parent_of(path)?;
        // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
        checked(unsafe { libc::mkdirat(parent, name.as_ptr(), 0o700) })?;
        let folder = open_folder_at(parent, &name)?;
        if !names(folder.0)?.is_empty() {
            return Err(io::Error::other("it is not the empty folder just made"));
        }
        self.folders.insert(path.to_vec(), folder);
        Ok(())
    }

    fn write_file(&mut self, path: &[String], bytes: &[u8], mode: u32) -> io::Result<()> {
        let (parent, name) = self.parent_of(path)?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `name` is NUL-terminated and `parent` is an open folder; the file is created where nothing is.
        let fd =
            checked(unsafe { libc::openat(parent, name.as_ptr(), flags, 0o600 as libc::c_uint) })?;
        // SAFETY: `fd` was just opened and is owned by `file` from here.
        let mut file = unsafe { File::from_raw_fd(fd) };
        file.write_all(bytes)?;
        // SAFETY: `file` is open.
        checked(unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) })?;
        Ok(())
    }

    fn set_folder_mode(&mut self, path: &[String], mode: u32) -> io::Result<()> {
        let folder = self
            .folders
            .get(path)
            .ok_or_else(|| io::Error::other("the folder was not made by this build"))?;
        // SAFETY: `folder` is open.
        checked(unsafe { libc::fchmod(folder.0, mode as libc::mode_t) })?;
        Ok(())
    }

    fn holds(&mut self, path: &[String], source: &Path) -> io::Result<bool> {
        let (parent, name) = self.parent_of(path)?;
        let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `name` is NUL-terminated and `parent` is an open folder.
        let fd = checked(unsafe { libc::openat(parent, name.as_ptr(), flags) })?;
        // SAFETY: `fd` was just opened and is owned by `written` from here.
        let mut written = unsafe { File::from_raw_fd(fd) };
        crate::same_contents(&mut written, &mut File::open(source)?)
    }

    fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()> {
        let root = self
            .folders
            .get(&Vec::new())
            .ok_or_else(|| io::Error::other("the output is not open"))?
            .0;
        let temporary = c_name(format!(".{name}.part-{:016x}", random_suffix()).as_bytes())?;
        let target = c_name(name.as_bytes())?;
        let flags =
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
        // SAFETY: `temporary` is NUL-terminated and `root` is the open output; the file is created where nothing is.
        let fd = checked(unsafe {
            libc::openat(root, temporary.as_ptr(), flags, 0o600 as libc::c_uint)
        })?;
        // SAFETY: `fd` was just opened and is owned by `file` from here.
        let mut file = unsafe { File::from_raw_fd(fd) };
        let written = (|| {
            file.write_all(bytes)?;
            // SAFETY: `file` is open.
            checked(unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) })?;
            // SAFETY: both names are NUL-terminated in the open output; nothing at `target` is replaced.
            checked(unsafe {
                libc::renameatx_np(
                    root,
                    temporary.as_ptr(),
                    root,
                    target.as_ptr(),
                    libc::RENAME_EXCL,
                )
            })?;
            Ok(())
        })();
        if written.is_err() {
            // The temporary file is this build's own, under a name no other program knows.
            // SAFETY: `temporary` is NUL-terminated in the open output.
            unsafe { libc::unlinkat(root, temporary.as_ptr(), 0) };
        }
        written
    }

    fn still_in_place(&mut self) -> io::Result<bool> {
        match open_path(&self.path) {
            Ok(fd) => Ok(identity(&status(fd.0)?) == self.claimed),
            Err(_) => Ok(false),
        }
    }

    fn files(&mut self) -> io::Result<BTreeSet<String>> {
        fn walk(fd: libc::c_int, prefix: &str, found: &mut BTreeSet<String>) -> io::Result<()> {
            for name in names(fd)? {
                // SAFETY: an all-zero stat is valid for the call to fill.
                let mut entry: libc::stat = unsafe { std::mem::zeroed() };
                // SAFETY: `name` is NUL-terminated and `entry` is writable.
                checked(unsafe {
                    libc::fstatat(fd, name.as_ptr(), &mut entry, libc::AT_SYMLINK_NOFOLLOW)
                })?;
                let text = name
                    .to_str()
                    .map_err(|_| io::Error::other("a name in the output is not UTF-8"))?;
                let path = if prefix.is_empty() {
                    text.to_owned()
                } else {
                    format!("{prefix}/{text}")
                };
                match entry.st_mode & libc::S_IFMT {
                    libc::S_IFDIR => walk(open_folder_at(fd, &name)?.0, &path, found)?,
                    libc::S_IFREG => {
                        found.insert(path);
                    }
                    _ => {
                        return Err(io::Error::other(format!(
                            "{path} is neither a regular file nor a folder"
                        )))
                    }
                }
            }
            Ok(())
        }
        let root = self
            .folders
            .get(&Vec::new())
            .ok_or_else(|| io::Error::other("the output is not open"))?;
        let mut found = BTreeSet::new();
        walk(root.0, "", &mut found)?;
        Ok(found)
    }
}

/// Opens `output` without following a link, when it is the folder `claimed` names.
pub fn open(output: &Path, claimed: &str) -> Result<Box<dyn Output>, Failure> {
    let fd = open_path(output).map_err(|_| Failure::not_claimed(output))?;
    if identity(&status(fd.0)?) != claimed {
        return Err(Failure::not_claimed(output));
    }
    let mut folders = HashMap::new();
    folders.insert(Vec::new(), fd);
    Ok(Box::new(Opened {
        path: output.to_path_buf(),
        claimed: claimed.to_owned(),
        folders,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{publish, staged};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("urx-output-macos-{:016x}", random_suffix()));
        std::fs::create_dir(&dir).unwrap();
        dir
    }

    fn mode(path: &Path) -> u32 {
        std::fs::symlink_metadata(path)
            .unwrap()
            .permissions()
            .mode()
            & 0o7777
    }

    fn staging(dir: &Path) -> PathBuf {
        let staging = dir.join("staging");
        std::fs::create_dir_all(staging.join("native")).unwrap();
        std::fs::write(staging.join("main.js"), "cli").unwrap();
        std::fs::write(staging.join("native").join("urx-native.node"), "addon").unwrap();
        std::fs::write(staging.join("record.json"), "record").unwrap();
        std::fs::set_permissions(
            staging.join("main.js"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::fs::set_permissions(
            staging.join("native").join("urx-native.node"),
            std::fs::Permissions::from_mode(0o600),
        )
        .unwrap();
        std::fs::set_permissions(
            staging.join("native"),
            std::fs::Permissions::from_mode(0o750),
        )
        .unwrap();
        staging
    }

    fn publish_into(staging: &Path, output: &Path, claimed: &str) -> Result<(), Failure> {
        let mut opened = open(output, claimed)?;
        publish(
            opened.as_mut(),
            &staged(staging).unwrap(),
            0o755,
            Some("record.json"),
        )
    }

    #[test]
    fn claims_an_absent_output_and_writes_into_it_with_the_staged_modes() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let claimed = claim(&output).unwrap();
        assert!(std::fs::read_dir(&output).unwrap().next().is_none());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            1,
            "the temporary name is gone"
        );
        publish_into(&staging(&dir), &output, &claimed).unwrap();
        assert_eq!(
            std::fs::read_to_string(output.join("record.json")).unwrap(),
            "record"
        );
        assert_eq!(
            [
                mode(&output),
                mode(&output.join("main.js")),
                mode(&output.join("native")),
                mode(&output.join("native").join("urx-native.node"))
            ],
            [0o755, 0o755, 0o750, 0o600]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leaves_whatever_is_at_the_output_an_empty_folder_and_a_dangling_link_included() {
        let dir = scratch();
        let full = dir.join("full");
        std::fs::create_dir(&full).unwrap();
        std::fs::write(full.join("keep.txt"), "the user's").unwrap();
        let empty = dir.join("empty");
        std::fs::create_dir(&empty).unwrap();
        let file = dir.join("file");
        std::fs::write(&file, "the user's").unwrap();
        let dangling = dir.join("dangling");
        symlink(dir.join("nowhere"), &dangling).unwrap();
        for path in [&full, &empty, &file, &dangling] {
            let before = std::fs::symlink_metadata(path).unwrap().ino();
            assert_eq!(claim(path).unwrap_err().code, 3, "{}", path.display());
            assert_eq!(std::fs::symlink_metadata(path).unwrap().ino(), before);
        }
        assert_eq!(
            std::fs::read_to_string(full.join("keep.txt")).unwrap(),
            "the user's"
        );
        assert!(std::fs::read_dir(&empty).unwrap().next().is_none());
        assert!(!dir.join("nowhere").exists());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            4,
            "no temporary folder is left"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_nothing_into_a_folder_put_in_place_of_the_claimed_one() {
        let dir = scratch();
        let output = dir.join("dist-bundle");
        let claimed = claim(&output).unwrap();
        let moved = dir.join("moved");
        std::fs::rename(&output, &moved).unwrap();
        std::fs::create_dir(&output).unwrap();
        std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o700)).unwrap();
        assert_eq!(
            publish_into(&staging(&dir), &output, &claimed)
                .unwrap_err()
                .code,
            4
        );
        assert_eq!(mode(&output), 0o700);
        assert!(std::fs::read_dir(&output).unwrap().next().is_none());
        assert!(std::fs::read_dir(&moved).unwrap().next().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_writing_into_the_claimed_folder_when_its_path_is_swapped_meanwhile() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let claimed = claim(&output).unwrap();
        let mut opened = open(&output, &claimed).unwrap();
        // Swapped after the folder was opened: the writes still go into the claimed folder.
        let moved = dir.join("moved");
        std::fs::rename(&output, &moved).unwrap();
        std::fs::create_dir(&output).unwrap();
        std::fs::set_permissions(&output, std::fs::Permissions::from_mode(0o700)).unwrap();
        publish(
            opened.as_mut(),
            &staged(&staging(&dir)).unwrap(),
            0o755,
            Some("record.json"),
        )
        .unwrap();
        assert!(!opened.still_in_place().unwrap());
        assert!(moved.join("record.json").is_file());
        assert_eq!(mode(&output), 0o700);
        assert!(std::fs::read_dir(&output).unwrap().next().is_none());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_the_record_under_a_temporary_name_and_replaces_nothing_at_its_own() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let claimed = claim(&output).unwrap();
        let mut opened = open(&output, &claimed).unwrap();
        opened
            .write_record("record.json", b"record", 0o644)
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(output.join("record.json")).unwrap(),
            "record"
        );
        assert_eq!(mode(&output.join("record.json")), 0o644);
        std::fs::write(output.join("other.json"), "the user's").unwrap();
        assert!(opened.write_record("other.json", b"record", 0o644).is_err());
        assert_eq!(
            std::fs::read_to_string(output.join("other.json")).unwrap(),
            "the user's"
        );
        let names: Vec<String> = std::fs::read_dir(&output)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names.len(), 2, "no temporary file is left: {names:?}");
        assert!(opened.still_in_place().unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn reads_back_what_it_wrote() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let claimed = claim(&output).unwrap();
        let mut opened = open(&output, &claimed).unwrap();
        std::fs::write(dir.join("source"), "cli").unwrap();
        let path = vec!["main.js".to_owned()];
        opened.write_file(&path, b"cli", 0o644).unwrap();
        assert!(opened.holds(&path, &dir.join("source")).unwrap());
        std::fs::write(output.join("main.js"), "clx").unwrap();
        assert!(!opened.holds(&path, &dir.join("source")).unwrap());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_nothing_in_the_way_and_then_writes_no_record() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let claimed = claim(&output).unwrap();
        std::fs::write(output.join("main.js"), "the user's").unwrap();
        assert_eq!(
            publish_into(&staging(&dir), &output, &claimed)
                .unwrap_err()
                .code,
            1
        );
        assert_eq!(
            std::fs::read_to_string(output.join("main.js")).unwrap(),
            "the user's"
        );
        assert!(!output.join("record.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_no_record_beside_a_file_or_a_link_it_did_not_write() {
        let dir = scratch();
        for (name, put) in [("file", 0), ("link", 1)] {
            let output = dir.join(format!("dist-{name}"));
            let claimed = claim(&output).unwrap();
            if put == 0 {
                std::fs::write(output.join("notes.txt"), "the user's").unwrap();
            } else {
                symlink(dir.join("elsewhere"), output.join("notes.txt")).unwrap();
            }
            assert!(
                publish_into(&staging(&dir), &output, &claimed).is_err(),
                "{name}"
            );
            assert!(!output.join("record.json").exists(), "{name}");
            std::fs::remove_dir_all(dir.join("staging")).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
