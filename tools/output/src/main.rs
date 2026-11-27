//! Publishes a build's output, for the release, bundle and installer builds,
//! so that the output's path shows either nothing or the complete output with
//! its record, and nothing already there is removed, replaced or changed.
//!
//! `urx-output publish <staging> <output> [--last <name>]`
//!
//! 1. When anything is at `<output>`, an empty folder or a link included, it
//!    exits 3 and touches nothing.
//! 2. It makes a work folder beside `<output>` under a random name no other
//!    program knows, holds it open, and writes the files of `<staging>` into
//!    it: on macOS each folder and file relative to its open parent, on
//!    Windows under folders held open without delete sharing. Every folder and
//!    file is created where nothing is; outside Windows, folder modes are set
//!    after their contents, the work folder's own last.
//! 3. It walks the work folder once, opening each folder by name and checking
//!    that it is the folder it made, and reads every file back against the
//!    staged one. A file beside them, a missing or changed file, or a
//!    replaced folder stops it.
//! 4. `<name>`, the record at the top of the output that marks it finished,
//!    is written under a temporary name, given its mode and renamed to its
//!    own name in the work folder.
//! 5. It renames the work folder to `<output>` only where nothing is (macOS:
//!    `renameatx_np` with `RENAME_EXCL`, after checking that the work
//!    folder's name still names the folder it holds; Windows: a rename of the
//!    held folder itself that does not replace). This rename is the moment the
//!    build succeeds and the next stage can see its output; nothing of it is
//!    touched afterwards, wherever the next stage takes it.
//!
//! When a step after the first fails, the record, if written, is removed from
//! the work folder through the open folder, and the work folder is left
//! without it, beside the output, for the user to remove; its path is in the
//! message. When something appeared at `<output>` in the meantime, it exits
//! 3; any other failure exits 1, and a wrong command line 2. Every failure
//! prints one line on standard error.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as platform;

/// Why a publish stopped, with the exit status it gives.
#[derive(Debug, PartialEq, Eq)]
pub struct Failure {
    pub code: u8,
    pub message: String,
}

impl Failure {
    pub fn exists(output: &Path) -> Failure {
        Failure {
            code: 3,
            message: format!("{} already exists", output.display()),
        }
    }

    pub fn other(message: impl Into<String>) -> Failure {
        Failure {
            code: 1,
            message: message.into(),
        }
    }
}

impl From<io::Error> for Failure {
    fn from(error: io::Error) -> Failure {
        Failure::other(error.to_string())
    }
}

/// One entry of the staged output, by its names below the staging folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entry {
    Folder {
        path: Vec<String>,
        mode: u32,
    },
    File {
        path: Vec<String>,
        mode: u32,
        source: PathBuf,
    },
}

/// What one walk of a work folder found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Found {
    /// Every regular file, as `/`-joined names.
    pub files: BTreeSet<String>,
    /// Files whose bytes are not those of the staged file.
    pub changed: Vec<String>,
    /// Folders that are not the ones this work made.
    pub replaced: Vec<String>,
    /// Entries that are neither regular files nor folders.
    pub others: Vec<String>,
}

/// The work folder the staged files are written into, folder by folder.
pub trait Work {
    /// The work folder's path, for messages.
    fn path(&self) -> &Path;
    /// Creates the folder `path` where nothing is, inside a folder this work
    /// made, and keeps it open.
    fn make_folder(&mut self, path: &[String]) -> io::Result<()>;
    /// Creates the file `path` where nothing is, with `bytes` and `mode`.
    fn write_file(&mut self, path: &[String], bytes: &[u8], mode: u32) -> io::Result<()>;
    /// Sets the mode of a folder this work made, or of the work folder itself
    /// for an empty `path`.
    fn set_folder_mode(&mut self, path: &[String], mode: u32) -> io::Result<()>;
    /// Walks the work folder once, opening each folder by name and checking
    /// that it is one this work made, and reads each file found against
    /// `expected` (its staged source by `/`-joined names).
    fn walk(&mut self, expected: &BTreeMap<String, PathBuf>) -> io::Result<Found>;
    /// Writes the file `name` at the top of the work folder with `bytes` and
    /// `mode` under a temporary name, then renames it to `name` where nothing
    /// is, so `name` appears only complete.
    fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()>;
    /// Removes the record `name` this work wrote.
    fn remove_record(&mut self, name: &str);
    /// Renames the work folder to the output where nothing is.
    fn publish(&mut self) -> Result<(), Failure>;
}

/// The mode a staged entry is written with: its permission bits outside
/// Windows, where modes are kept, and 0 on Windows.
fn mode_of(metadata: &std::fs::Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o7777
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        0
    }
}

/// The staged output under `root`, each folder before what it holds and
/// names in order. Only folders and regular files with UTF-8 names may be
/// staged.
pub fn staged(root: &Path) -> io::Result<Vec<Entry>> {
    fn walk(directory: &Path, prefix: &[String], found: &mut Vec<Entry>) -> io::Result<()> {
        let mut names = Vec::new();
        for entry in std::fs::read_dir(directory)? {
            names.push(entry?.file_name());
        }
        names.sort();
        for name in names {
            let text = name.to_str().ok_or_else(|| {
                io::Error::other(format!(
                    "{} has a name that is not UTF-8",
                    directory.display()
                ))
            })?;
            let source = directory.join(&name);
            let metadata = std::fs::symlink_metadata(&source)?;
            let mut path = prefix.to_vec();
            path.push(text.to_owned());
            if metadata.file_type().is_dir() {
                found.push(Entry::Folder {
                    path: path.clone(),
                    mode: mode_of(&metadata),
                });
                walk(&source, &path, found)?;
            } else if metadata.file_type().is_file() {
                found.push(Entry::File {
                    path,
                    mode: mode_of(&metadata),
                    source,
                });
            } else {
                return Err(io::Error::other(format!(
                    "{} is neither a regular file nor a folder",
                    source.display()
                )));
            }
        }
        Ok(())
    }
    let mut found = Vec::new();
    walk(root, &[], &mut found)?;
    Ok(found)
}

/// Whether `a` and `b` read the same bytes to their ends.
pub fn same_contents(a: &mut impl io::Read, b: &mut impl io::Read) -> io::Result<bool> {
    let mut left = vec![0u8; 1 << 20];
    let mut right = vec![0u8; 1 << 20];
    loop {
        let from_a = read_full(a, &mut left)?;
        let from_b = read_full(b, &mut right)?;
        if from_a != from_b || left[..from_a] != right[..from_b] {
            return Ok(false);
        }
        if from_a == 0 {
            return Ok(true);
        }
    }
}

/// Fills `buffer` from `reader` as far as it goes, returning how much was read.
fn read_full(reader: &mut impl io::Read, buffer: &mut [u8]) -> io::Result<usize> {
    let mut filled = 0;
    while filled < buffer.len() {
        match reader.read(&mut buffer[filled..])? {
            0 => break,
            read => filled += read,
        }
    }
    Ok(filled)
}

/// Writes `entries` into `work`, checks what it holds, adds `last`, a file at
/// the top of the staged output, and publishes it. When the publishing rename
/// does not happen after the record was written, the record is removed again
/// from the work folder, which is then not published.
pub fn publish(
    work: &mut dyn Work,
    entries: &[Entry],
    root_mode: u32,
    last: Option<&str>,
) -> Result<(), Failure> {
    let is_last =
        |path: &[String]| matches!(last, Some(name) if path.len() == 1 && path[0] == name);
    let named = |path: &[String]| path.join("/");
    let mut record = None;
    for entry in entries {
        match entry {
            Entry::Folder { path, .. } => work.make_folder(path).map_err(|error| {
                Failure::other(format!(
                    "{} could not be made where nothing is: {error}",
                    named(path)
                ))
            })?,
            Entry::File { path, mode, source } => {
                if is_last(path) {
                    record = Some((path[0].clone(), *mode, source));
                    continue;
                }
                let bytes = std::fs::read(source)?;
                work.write_file(path, &bytes, *mode).map_err(|error| {
                    Failure::other(format!(
                        "{} could not be written where nothing is: {error}",
                        named(path)
                    ))
                })?;
            }
        }
    }
    if let Some(name) = last {
        if record.is_none() {
            return Err(Failure::other(format!("the staged output holds no {name}")));
        }
    }
    for entry in entries.iter().rev() {
        if let Entry::Folder { path, mode } = entry {
            work.set_folder_mode(path, *mode).map_err(|error| {
                Failure::other(format!(
                    "the mode of {} could not be set: {error}",
                    named(path)
                ))
            })?;
        }
    }
    work.set_folder_mode(&[], root_mode)
        .map_err(|error| Failure::other(format!("the output's mode could not be set: {error}")))?;
    let expected: BTreeMap<String, PathBuf> = entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::File { path, source, .. } if !is_last(path) => {
                Some((named(path), source.clone()))
            }
            _ => None,
        })
        .collect();
    let found = work
        .walk(&expected)
        .map_err(|error| Failure::other(format!("the output could not be read back: {error}")))?;
    let mut problems = Vec::new();
    for path in &found.replaced {
        problems.push(format!("{path} is not the folder this build made"));
    }
    for path in &found.others {
        problems.push(format!("{path} is neither a regular file nor a folder"));
    }
    for path in found
        .files
        .iter()
        .filter(|path| !expected.contains_key(*path))
    {
        problems.push(format!("{path} was not written by this build"));
    }
    for path in expected.keys().filter(|path| !found.files.contains(*path)) {
        problems.push(format!("{path} is missing"));
    }
    for path in &found.changed {
        problems.push(format!("{path} changed after it was written"));
    }
    if !problems.is_empty() {
        return Err(Failure::other(format!(
            "the output is not as this build wrote it: {}",
            problems.join("; ")
        )));
    }
    let Some((name, mode, source)) = record else {
        return work.publish();
    };
    let bytes = std::fs::read(source)?;
    work.write_record(&name, &bytes, mode).map_err(|error| {
        Failure::other(format!(
            "{name} could not be written where nothing is: {error}"
        ))
    })?;
    let published = work.publish();
    if published.is_err() {
        work.remove_record(&name);
    }
    published
}

/// A name for a folder beside the output that no other program can know.
pub fn random_suffix() -> u64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    hasher.write_u128(now);
    hasher.write_u32(std::process::id());
    hasher.finish()
}

const USAGE: &str = "usage: urx-output publish <staging> <output> [--last <name>]";

fn run(args: &[String]) -> Result<(), Failure> {
    let usage = || Failure {
        code: 2,
        message: USAGE.to_owned(),
    };
    let [command, staging, output, rest @ ..] = args else {
        return Err(usage());
    };
    if command != "publish" {
        return Err(usage());
    }
    let last = match rest {
        [] => None,
        [flag, name] if flag == "--last" => Some(name.as_str()),
        _ => return Err(usage()),
    };
    let staging = Path::new(staging);
    let entries = staged(staging)?;
    let root_mode = mode_of(&std::fs::symlink_metadata(staging)?);
    let mut work = create_work(Path::new(output))?;
    publish(work.as_mut(), &entries, root_mode, last).map_err(|failure| Failure {
        code: failure.code,
        message: format!(
            "{}; this build's files are left in {} without a record, for you to remove",
            failure.message,
            work.path().display()
        ),
    })
}

#[cfg(any(target_os = "macos", windows))]
fn create_work(output: &Path) -> Result<Box<dyn Work>, Failure> {
    platform::create_work(output)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn create_work(_output: &Path) -> Result<Box<dyn Work>, Failure> {
    Err(Failure::other(
        "outputs are published on macOS and Windows only",
    ))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(()) => ExitCode::SUCCESS,
        Err(failure) => {
            eprintln!("urx-output: {}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A change to what a walk finds.
    type Change = fn(&mut Found);

    /// A work folder that records what was written and can be made to fail.
    #[derive(Default)]
    struct Recorded {
        calls: Vec<String>,
        fail_root_mode: bool,
        fail_publish: bool,
        /// Changes what the walk finds, after the writes.
        change: Option<Change>,
        found: Found,
    }

    impl Work for Recorded {
        fn path(&self) -> &Path {
            Path::new("work")
        }
        fn make_folder(&mut self, path: &[String]) -> io::Result<()> {
            self.calls.push(format!("folder {}", path.join("/")));
            Ok(())
        }
        fn write_file(&mut self, path: &[String], bytes: &[u8], mode: u32) -> io::Result<()> {
            self.calls.push(format!(
                "file {} {} {mode:o}",
                path.join("/"),
                String::from_utf8_lossy(bytes)
            ));
            self.found.files.insert(path.join("/"));
            Ok(())
        }
        fn set_folder_mode(&mut self, path: &[String], mode: u32) -> io::Result<()> {
            if path.is_empty() && self.fail_root_mode {
                return Err(io::Error::other("denied"));
            }
            self.calls.push(format!("mode {} {mode:o}", path.join("/")));
            Ok(())
        }
        fn walk(&mut self, _expected: &BTreeMap<String, PathBuf>) -> io::Result<Found> {
            self.calls.push("walk".to_owned());
            if let Some(change) = self.change {
                change(&mut self.found);
            }
            Ok(std::mem::take(&mut self.found))
        }
        fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()> {
            self.calls.push(format!(
                "record {name} {} {mode:o}",
                String::from_utf8_lossy(bytes)
            ));
            Ok(())
        }
        fn remove_record(&mut self, name: &str) {
            self.calls.push(format!("remove {name}"));
        }
        fn publish(&mut self) -> Result<(), Failure> {
            if self.fail_publish {
                return Err(Failure::exists(Path::new("output")));
            }
            self.calls.push("publish".to_owned());
            Ok(())
        }
    }

    fn staging() -> (PathBuf, Vec<Entry>) {
        let root = std::env::temp_dir().join(format!("urx-output-test-{:016x}", random_suffix()));
        std::fs::create_dir_all(root.join("app")).unwrap();
        std::fs::write(root.join("app").join("main.js"), "cli").unwrap();
        std::fs::write(root.join("record.json"), "record").unwrap();
        std::fs::write(root.join("a.txt"), "a").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for (path, mode) in [
                ("a.txt", 0o644),
                ("app", 0o755),
                ("app/main.js", 0o644),
                ("record.json", 0o644),
            ] {
                std::fs::set_permissions(root.join(path), std::fs::Permissions::from_mode(mode))
                    .unwrap();
            }
        }
        let entries = staged(&root).unwrap();
        (root, entries)
    }

    #[test]
    fn writes_checks_records_then_publishes() {
        let (root, entries) = staging();
        let mut work = Recorded::default();
        publish(&mut work, &entries, 0o755, Some("record.json")).unwrap();
        let (file, folder) = if cfg!(unix) {
            ("644", "755")
        } else {
            ("0", "0")
        };
        assert_eq!(
            work.calls,
            vec![
                format!("file a.txt a {file}"),
                "folder app".to_owned(),
                format!("file app/main.js cli {file}"),
                format!("mode app {folder}"),
                "mode  755".to_owned(),
                "walk".to_owned(),
                format!("record record.json record {file}"),
                "publish".to_owned(),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn neither_records_nor_publishes_what_is_not_as_written() {
        let (root, entries) = staging();
        let cases: [(Change, &str); 5] = [
            (
                |found| {
                    found.files.insert("notes.txt".to_owned());
                },
                "notes.txt was not written by this build",
            ),
            (
                |found| {
                    found.files.remove("a.txt");
                },
                "a.txt is missing",
            ),
            (
                |found| found.changed.push("app/main.js".to_owned()),
                "app/main.js changed after it was written",
            ),
            (
                |found| found.replaced.push("app".to_owned()),
                "app is not the folder this build made",
            ),
            (
                |found| found.others.push("link".to_owned()),
                "link is neither a regular file nor a folder",
            ),
        ];
        for (change, expected) in cases {
            let mut work = Recorded {
                change: Some(change),
                ..Recorded::default()
            };
            let failure = publish(&mut work, &entries, 0o755, Some("record.json")).unwrap_err();
            assert!(
                failure.message.contains(expected),
                "{} lacks {expected}",
                failure.message
            );
            assert!(
                !work
                    .calls
                    .iter()
                    .any(|call| call.starts_with("record ") || call == "publish"),
                "{expected}"
            );
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn neither_records_nor_publishes_when_the_output_mode_cannot_be_set() {
        let (root, entries) = staging();
        let mut work = Recorded {
            fail_root_mode: true,
            ..Recorded::default()
        };
        assert!(publish(&mut work, &entries, 0o755, Some("record.json")).is_err());
        assert!(!work
            .calls
            .iter()
            .any(|call| call.starts_with("record ") || call == "publish"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removes_its_record_again_when_the_output_cannot_be_published() {
        let (root, entries) = staging();
        let mut work = Recorded {
            fail_publish: true,
            ..Recorded::default()
        };
        assert_eq!(
            publish(&mut work, &entries, 0o755, Some("record.json"))
                .unwrap_err()
                .code,
            3
        );
        assert_eq!(
            work.calls.last().map(String::as_str),
            Some("remove record.json")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_a_record_that_was_not_staged() {
        let (root, entries) = staging();
        let mut work = Recorded::default();
        let failure = publish(&mut work, &entries, 0o755, Some("missing.json")).unwrap_err();
        assert_eq!(failure.message, "the staged output holds no missing.json");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn compares_contents_to_their_ends() {
        let compare = |a: &[u8], b: &[u8]| same_contents(&mut &a[..], &mut &b[..]).unwrap();
        assert!(compare(b"", b""));
        assert!(compare(b"same", b"same"));
        assert!(!compare(b"same", b"sane"));
        assert!(!compare(b"same", b"same and more"));
        assert!(!compare(b"same and more", b"same"));
        let long = vec![7u8; (1 << 20) + 3];
        let mut other = long.clone();
        assert!(compare(&long, &other));
        other[(1 << 20) + 1] = 8;
        assert!(!compare(&long, &other));
        assert!(!compare(&long, &long[..1 << 20]));
    }

    #[test]
    fn reads_its_command_line() {
        assert_eq!(run(&[]).unwrap_err().code, 2);
        assert_eq!(
            run(&["claim".into(), "s".into(), "o".into()])
                .unwrap_err()
                .code,
            2
        );
        assert_eq!(
            run(&[
                "publish".into(),
                "s".into(),
                "o".into(),
                "--first".into(),
                "x".into()
            ])
            .unwrap_err()
            .code,
            2
        );
    }
}
