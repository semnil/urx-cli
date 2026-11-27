//! The work folder on macOS. Every folder and file is made relative to its
//! open parent; the walk opens each folder by name from the open work folder
//! and checks it against the one made; the work folder is renamed to the
//! output with `RENAME_EXCL`, which replaces nothing.

use crate::{random_suffix, same_contents, Failure, Found, Work};
use std::collections::{BTreeMap, HashMap};
use std::ffi::{CStr, CString};
use std::fs::File;
use std::io::{self, Write};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::path::{Path, PathBuf};

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

/// What is at `name` in the open folder `parent`, not following a link, or
/// None when nothing is.
fn status_at(parent: libc::c_int, name: &CStr) -> io::Result<Option<libc::stat>> {
    // SAFETY: an all-zero stat is valid for the call to fill.
    let mut found: libc::stat = unsafe { std::mem::zeroed() };
    // SAFETY: `name` is NUL-terminated and `found` is writable.
    if unsafe { libc::fstatat(parent, name.as_ptr(), &mut found, libc::AT_SYMLINK_NOFOLLOW) } == 0 {
        return Ok(Some(found));
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ENOENT) {
        Ok(None)
    } else {
        Err(error)
    }
}

fn same_entry(a: &libc::stat, b: &libc::stat) -> bool {
    a.st_dev == b.st_dev && a.st_ino == b.st_ino
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

/// Creates a file `name` where nothing is in the open folder `parent` and
/// writes `bytes` with `mode`.
fn create_file_at(parent: libc::c_int, name: &CStr, bytes: &[u8], mode: u32) -> io::Result<()> {
    let flags = libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    // SAFETY: `name` is NUL-terminated and `parent` is an open folder; the file is created where nothing is.
    let fd = checked(unsafe { libc::openat(parent, name.as_ptr(), flags, 0o600 as libc::c_uint) })?;
    // SAFETY: `fd` was just opened and is owned by `file` from here.
    let mut file = unsafe { File::from_raw_fd(fd) };
    file.write_all(bytes)?;
    // SAFETY: `file` is open.
    checked(unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) })?;
    Ok(())
}

/// The work folder beside the output, with the folders made in it, all open.
struct MacWork {
    output: PathBuf,
    path: PathBuf,
    parent: Fd,
    name: CString,
    target: CString,
    folders: HashMap<Vec<String>, Fd>,
}

/// Makes the work folder for `output`, beside it under a random name, when
/// nothing is at `output`.
pub fn create_work(output: &Path) -> Result<Box<dyn Work>, Failure> {
    let parent = match output.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let base = output
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
    let target = c_name(base.as_bytes())?;
    if status_at(parent_fd.0, &target)?.is_some() {
        return Err(Failure::exists(output));
    }
    for _ in 0..16 {
        let work_name = format!("{}.work-{:016x}", base.to_string_lossy(), random_suffix());
        let name = c_name(work_name.as_bytes())?;
        // SAFETY: `name` is NUL-terminated and `parent_fd` is an open folder.
        if let Err(error) = checked(unsafe { libc::mkdirat(parent_fd.0, name.as_ptr(), 0o700) }) {
            if error.raw_os_error() == Some(libc::EEXIST) {
                continue;
            }
            return Err(error.into());
        }
        let root = open_folder_at(parent_fd.0, &name)?;
        if !names(root.0)?.is_empty() {
            return Err(Failure::other("the work folder just made is not empty"));
        }
        let mut folders = HashMap::new();
        folders.insert(Vec::new(), root);
        return Ok(Box::new(MacWork {
            output: output.to_path_buf(),
            path: parent.join(work_name),
            parent: parent_fd,
            name,
            target,
            folders,
        }));
    }
    Err(Failure::other(
        "no unused name was found for the work folder",
    ))
}

impl MacWork {
    fn root(&self) -> io::Result<libc::c_int> {
        Ok(self
            .folders
            .get(&Vec::new())
            .ok_or_else(|| io::Error::other("the work folder is not open"))?
            .0)
    }

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

impl Work for MacWork {
    fn path(&self) -> &Path {
        &self.path
    }

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
        create_file_at(parent, &name, bytes, mode)
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

    fn walk(&mut self, expected: &BTreeMap<String, PathBuf>) -> io::Result<Found> {
        fn visit(
            work: &MacWork,
            fd: libc::c_int,
            prefix: &[String],
            expected: &BTreeMap<String, PathBuf>,
            found: &mut Found,
        ) -> io::Result<()> {
            for name in names(fd)? {
                let text = name
                    .to_str()
                    .map_err(|_| io::Error::other("a name in the output is not UTF-8"))?;
                let mut path = prefix.to_vec();
                path.push(text.to_owned());
                let joined = path.join("/");
                let Some(entry) = status_at(fd, &name)? else {
                    continue;
                };
                match entry.st_mode & libc::S_IFMT {
                    libc::S_IFDIR => {
                        let opened = open_folder_at(fd, &name)?;
                        let made = match work.folders.get(&path) {
                            Some(made) => same_entry(&status(made.0)?, &status(opened.0)?),
                            None => false,
                        };
                        if made {
                            visit(work, opened.0, &path, expected, found)?;
                        } else {
                            found.replaced.push(joined);
                        }
                    }
                    libc::S_IFREG => {
                        if let Some(source) = expected.get(&joined) {
                            let flags = libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
                            // SAFETY: `name` is NUL-terminated and `fd` is an open folder.
                            let read = checked(unsafe { libc::openat(fd, name.as_ptr(), flags) })?;
                            // SAFETY: `read` was just opened and is owned by `written` from here.
                            let mut written = unsafe { File::from_raw_fd(read) };
                            if !same_contents(&mut written, &mut File::open(source)?)? {
                                found.changed.push(joined.clone());
                            }
                        }
                        found.files.insert(joined);
                    }
                    _ => found.others.push(joined),
                }
            }
            Ok(())
        }
        let mut found = Found::default();
        visit(self, self.root()?, &[], expected, &mut found)?;
        Ok(found)
    }

    fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()> {
        let root = self.root()?;
        let temporary = c_name(format!(".{name}.part-{:016x}", random_suffix()).as_bytes())?;
        let target = c_name(name.as_bytes())?;
        let written = create_file_at(root, &temporary, bytes, mode).and_then(|()| {
            // SAFETY: both names are NUL-terminated in the open work folder; nothing at `target` is replaced.
            checked(unsafe {
                libc::renameatx_np(
                    root,
                    temporary.as_ptr(),
                    root,
                    target.as_ptr(),
                    libc::RENAME_EXCL,
                )
            })
            .map(|_| ())
        });
        if written.is_err() {
            // The temporary file is this build's own, in its own work folder.
            // SAFETY: `temporary` is NUL-terminated in the open work folder.
            unsafe { libc::unlinkat(root, temporary.as_ptr(), 0) };
        }
        written
    }

    fn remove_record(&mut self, name: &str) {
        if let (Ok(root), Ok(target)) = (self.root(), c_name(name.as_bytes())) {
            // SAFETY: `target` is NUL-terminated in the open work folder, this build's own.
            unsafe { libc::unlinkat(root, target.as_ptr(), 0) };
        }
    }

    fn publish(&mut self) -> Result<(), Failure> {
        let held = status(self.root()?)?;
        // The work folder's name still names the folder held, so the rename moves this build's own.
        match status_at(self.parent.0, &self.name)? {
            Some(named) if same_entry(&named, &held) => {}
            _ => {
                return Err(Failure::other(format!(
                    "the work folder {} was replaced or moved, so nothing is published",
                    self.path.display()
                )))
            }
        }
        // SAFETY: both names are NUL-terminated in the open parent; nothing at the output is replaced.
        let renamed = unsafe {
            libc::renameatx_np(
                self.parent.0,
                self.name.as_ptr(),
                self.parent.0,
                self.target.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        if renamed < 0 {
            let error = io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(libc::EEXIST) {
                Failure::exists(&self.output)
            } else {
                Failure::other(format!(
                    "{} could not be published: {error}",
                    self.output.display()
                ))
            });
        }
        // Published: the output is the next stage's from here, wherever it takes it.
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{publish, staged};
    use std::os::unix::fs::{symlink, MetadataExt, PermissionsExt};

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

    fn entries(dir: &Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        names
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

    fn publish_to(dir: &Path, output: &Path) -> Result<(), Failure> {
        let mut work = create_work(output)?;
        publish(
            work.as_mut(),
            &staged(&staging(dir)).unwrap(),
            0o755,
            Some("record.json"),
        )
    }

    #[test]
    fn publishes_the_complete_output_with_its_modes_and_leaves_no_work_folder() {
        let dir = scratch();
        let output = dir.join("dist-release");
        publish_to(&dir, &output).unwrap();
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
        assert_eq!(entries(&dir), ["dist-release", "staging"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leaves_whatever_is_at_the_output_and_makes_no_work_folder() {
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
            assert_eq!(
                create_work(path).err().map(|failure| failure.code),
                Some(3),
                "{}",
                path.display()
            );
            assert_eq!(std::fs::symlink_metadata(path).unwrap().ino(), before);
        }
        assert_eq!(
            std::fs::read_to_string(full.join("keep.txt")).unwrap(),
            "the user's"
        );
        assert!(std::fs::read_dir(&empty).unwrap().next().is_none());
        assert_eq!(entries(&dir), ["dangling", "empty", "file", "full"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn leaves_what_appears_at_the_output_before_the_rename_and_keeps_no_record() {
        let dir = scratch();
        let output = dir.join("dist-bundle");
        let mut work = create_work(&output).unwrap();
        let work_path = work.path().to_path_buf();
        std::fs::create_dir(&output).unwrap();
        let before = std::fs::symlink_metadata(&output).unwrap().ino();
        let failure = publish(
            work.as_mut(),
            &staged(&staging(&dir)).unwrap(),
            0o755,
            Some("record.json"),
        )
        .unwrap_err();
        assert_eq!(failure.code, 3);
        assert_eq!(std::fs::symlink_metadata(&output).unwrap().ino(), before);
        assert!(std::fs::read_dir(&output).unwrap().next().is_none());
        assert!(work_path.join("main.js").is_file());
        assert!(!work_path.join("record.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn publishes_nothing_when_its_work_folder_was_replaced() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let mut work = create_work(&output).unwrap();
        let work_path = work.path().to_path_buf();
        std::fs::rename(&work_path, dir.join("moved")).unwrap();
        std::fs::create_dir(&work_path).unwrap();
        let failure = publish(
            work.as_mut(),
            &staged(&staging(&dir)).unwrap(),
            0o755,
            Some("record.json"),
        )
        .unwrap_err();
        assert!(
            failure.message.contains("was replaced or moved"),
            "{}",
            failure.message
        );
        assert!(!output.exists());
        assert!(std::fs::read_dir(&work_path).unwrap().next().is_none());
        assert!(!dir.join("moved").join("record.json").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn finds_a_folder_replaced_in_the_work_folder_and_a_file_changed_after_writing() {
        let dir = scratch();
        let staged_entries = staged(&staging(&dir)).unwrap();
        let expected: BTreeMap<String, PathBuf> = [
            ("main.js".to_owned(), dir.join("staging").join("main.js")),
            (
                "native/urx-native.node".to_owned(),
                dir.join("staging").join("native").join("urx-native.node"),
            ),
        ]
        .into_iter()
        .collect();
        let mut work = create_work(&dir.join("dist-bundle")).unwrap();
        let work_path = work.path().to_path_buf();
        work.make_folder(&["native".to_owned()]).unwrap();
        work.write_file(
            &["native".to_owned(), "urx-native.node".to_owned()],
            b"addon",
            0o600,
        )
        .unwrap();
        work.write_file(&["main.js".to_owned()], b"cli", 0o644)
            .unwrap();
        let fine = work.walk(&expected).unwrap();
        assert!(fine.changed.is_empty() && fine.replaced.is_empty() && fine.others.is_empty());
        // A copy with the same names in place of the folder made, and a file changed after it was written.
        std::fs::rename(work_path.join("native"), dir.join("native-moved")).unwrap();
        std::fs::create_dir(work_path.join("native")).unwrap();
        std::fs::write(work_path.join("native").join("urx-native.node"), "addon").unwrap();
        std::fs::write(work_path.join("main.js"), "clx").unwrap();
        let found = work.walk(&expected).unwrap();
        assert_eq!(found.replaced, ["native"]);
        assert_eq!(found.changed, ["main.js"]);
        drop(staged_entries);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn writes_the_record_under_a_temporary_name_and_replaces_nothing_at_its_own() {
        let dir = scratch();
        let mut work = create_work(&dir.join("dist-release")).unwrap();
        let work_path = work.path().to_path_buf();
        work.write_record("record.json", b"record", 0o644).unwrap();
        assert_eq!(
            std::fs::read_to_string(work_path.join("record.json")).unwrap(),
            "record"
        );
        assert_eq!(mode(&work_path.join("record.json")), 0o644);
        std::fs::write(work_path.join("other.json"), "the user's").unwrap();
        assert!(work.write_record("other.json", b"record", 0o644).is_err());
        assert_eq!(
            std::fs::read_to_string(work_path.join("other.json")).unwrap(),
            "the user's"
        );
        assert_eq!(entries(&work_path), ["other.json", "record.json"]);
        work.remove_record("record.json");
        assert_eq!(entries(&work_path), ["other.json"]);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn replaces_nothing_in_the_way_and_then_publishes_nothing() {
        let dir = scratch();
        let output = dir.join("dist-release");
        let mut work = create_work(&output).unwrap();
        std::fs::write(work.path().join("main.js"), "the user's").unwrap();
        let work_path = work.path().to_path_buf();
        assert!(publish(
            work.as_mut(),
            &staged(&staging(&dir)).unwrap(),
            0o755,
            Some("record.json")
        )
        .is_err());
        assert_eq!(
            std::fs::read_to_string(work_path.join("main.js")).unwrap(),
            "the user's"
        );
        assert!(!output.exists());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
