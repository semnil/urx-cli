//! Claims a build's output folder and writes the build's files into that
//! folder alone, for the release, bundle and installer builds. A build never
//! removes, replaces or changes what is not its own at its output path.
//!
//! - `urx-output claim <output>` makes a folder under a random name beside
//!   `<output>`, opens it, and renames that open folder to `<output>` only
//!   where nothing is (macOS: `renameatx_np` with `RENAME_EXCL`; Windows: a
//!   rename of the open handle that does not replace). It prints the claimed
//!   folder's identity. It exits 3 when anything is at `<output>`.
//! - `urx-output publish <staging> <output> <identity> [--last <name>]`
//!   opens `<output>` without following a link and goes on only when it is
//!   the claimed folder; it exits 4 otherwise. It then writes the files of
//!   `<staging>` into that folder: on macOS each folder and file is created
//!   relative to its open parent, so a path swapped meanwhile cannot redirect
//!   a write; on Windows each folder is held open without delete sharing, so
//!   none can be renamed or removed meanwhile. Every folder and file is
//!   created where nothing is. Outside Windows, folder modes are set after
//!   their contents, the output's own last. `<name>`, the record at the top of
//!   the output that marks it finished, comes after that, and only when the
//!   output holds exactly the files written beside it, each with the bytes
//!   written: it is written and given its mode under a temporary name, then
//!   renamed to `<name>` where nothing is. Last, `<output>` must still be the
//!   claimed folder; it exits 5 when the folder was moved meanwhile, its
//!   files written into it wherever it went.
//! - `urx-output check <output> <identity>` exits 0 when `<output>` is the
//!   claimed folder and 4 otherwise, so a build that stops says to remove
//!   only a folder that is its own.
//!
//! Any other failure exits 1, and a wrong command line 2. Every failure
//! prints one line on standard error.

use std::collections::BTreeSet;
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

/// Why a claim or a publish stopped, with the exit status it gives.
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

    pub fn not_claimed(output: &Path) -> Failure {
        Failure {
            code: 4,
            message: format!("{} is not the folder this build claimed", output.display()),
        }
    }

    pub fn moved(output: &Path) -> Failure {
        Failure {
            code: 5,
            message: format!(
                "{} was moved while it was written, so it no longer names this build's output",
                output.display()
            ),
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

/// The output the staged files are written into, folder by folder.
pub trait Output {
    /// Creates the folder `path` where nothing is, inside a folder this
    /// output made, and keeps it for what goes into it.
    fn make_folder(&mut self, path: &[String]) -> io::Result<()>;
    /// Creates the file `path` where nothing is, with `bytes` and `mode`.
    fn write_file(&mut self, path: &[String], bytes: &[u8], mode: u32) -> io::Result<()>;
    /// Sets the mode of a folder this output made, or of the output itself
    /// for an empty `path`.
    fn set_folder_mode(&mut self, path: &[String], mode: u32) -> io::Result<()>;
    /// Every regular file in the output, as `/`-joined names; a link or
    /// another kind of entry is an error.
    fn files(&mut self) -> io::Result<BTreeSet<String>>;
    /// Whether the file `path` this output wrote holds the bytes of `source`.
    fn holds(&mut self, path: &[String], source: &Path) -> io::Result<bool>;
    /// Writes the file `name` at the top of the output with `bytes` and
    /// `mode` under a temporary name, then renames it to `name` where nothing
    /// is, so `name` appears only complete.
    fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()>;
    /// Whether the output's path still names the folder written into.
    fn still_in_place(&mut self) -> io::Result<bool>;
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

/// Writes `entries` into `output`: folders and files where nothing is, then
/// folder modes from the deepest to the output's own (`root_mode`), then,
/// when `output` holds exactly the files written, `last`, a file at the top of
/// the staged output.
pub fn publish(
    output: &mut dyn Output,
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
            Entry::Folder { path, .. } => output.make_folder(path).map_err(|error| {
                Failure::other(format!(
                    "{} could not be made where nothing is: {error}",
                    named(path)
                ))
            })?,
            Entry::File { path, mode, source } => {
                if is_last(path) {
                    record = Some((path, *mode, source));
                    continue;
                }
                let bytes = std::fs::read(source)?;
                output.write_file(path, &bytes, *mode).map_err(|error| {
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
            output.set_folder_mode(path, *mode).map_err(|error| {
                Failure::other(format!(
                    "the mode of {} could not be set: {error}",
                    named(path)
                ))
            })?;
        }
    }
    output
        .set_folder_mode(&[], root_mode)
        .map_err(|error| Failure::other(format!("the output's mode could not be set: {error}")))?;
    let written: BTreeSet<String> = entries
        .iter()
        .filter_map(|entry| match entry {
            Entry::File { path, .. } if !is_last(path) => Some(named(path)),
            _ => None,
        })
        .collect();
    let present = output
        .files()
        .map_err(|error| Failure::other(format!("the output could not be listed: {error}")))?;
    let beside: Vec<&str> = present.difference(&written).map(String::as_str).collect();
    if !beside.is_empty() {
        return Err(Failure::other(format!(
            "the output holds files this build did not write, left as they are: {}",
            beside.join(", ")
        )));
    }
    let lacking: Vec<&str> = written.difference(&present).map(String::as_str).collect();
    if !lacking.is_empty() {
        return Err(Failure::other(format!(
            "the output lacks files this build wrote: {}",
            lacking.join(", ")
        )));
    }
    for entry in entries {
        if let Entry::File { path, source, .. } = entry {
            if is_last(path) {
                continue;
            }
            let same = output.holds(path, source).map_err(|error| {
                Failure::other(format!("{} could not be read back: {error}", named(path)))
            })?;
            if !same {
                return Err(Failure::other(format!(
                    "{} changed after it was written",
                    named(path)
                )));
            }
        }
    }
    if let Some((path, mode, source)) = record {
        let bytes = std::fs::read(source)?;
        output
            .write_record(&path[0], &bytes, mode)
            .map_err(|error| {
                Failure::other(format!(
                    "{} could not be written where nothing is: {error}",
                    named(path)
                ))
            })?;
    }
    Ok(())
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

const USAGE: &str = "usage: urx-output claim <output> | urx-output publish <staging> <output> <identity> [--last <name>] | urx-output check <output> <identity>";

fn run(args: &[String]) -> Result<Option<String>, Failure> {
    let usage = || Failure {
        code: 2,
        message: USAGE.to_owned(),
    };
    match args {
        [command, output] if command == "claim" => claim(Path::new(output)).map(Some),
        [command, staging, output, identity, rest @ ..] if command == "publish" => {
            let last = match rest {
                [] => None,
                [flag, name] if flag == "--last" => Some(name.as_str()),
                _ => return Err(usage()),
            };
            let staging = Path::new(staging);
            let entries = staged(staging)?;
            let root_mode = mode_of(&std::fs::symlink_metadata(staging)?);
            let mut opened = open(Path::new(output), identity)?;
            publish(opened.as_mut(), &entries, root_mode, last)?;
            if !opened.still_in_place()? {
                return Err(Failure::moved(Path::new(output)));
            }
            Ok(None)
        }
        [command, output, identity] if command == "check" => {
            open(Path::new(output), identity)?;
            Ok(None)
        }
        _ => Err(usage()),
    }
}

#[cfg(any(target_os = "macos", windows))]
fn claim(output: &Path) -> Result<String, Failure> {
    platform::claim(output)
}

#[cfg(any(target_os = "macos", windows))]
fn open(output: &Path, identity: &str) -> Result<Box<dyn Output>, Failure> {
    platform::open(output, identity)
}

#[cfg(not(any(target_os = "macos", windows)))]
fn claim(_output: &Path) -> Result<String, Failure> {
    Err(Failure::other(
        "outputs are claimed on macOS and Windows only",
    ))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn open(_output: &Path, _identity: &str) -> Result<Box<dyn Output>, Failure> {
    Err(Failure::other(
        "outputs are written on macOS and Windows only",
    ))
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(printed) => {
            if let Some(text) = printed {
                println!("{text}");
            }
            ExitCode::SUCCESS
        }
        Err(failure) => {
            eprintln!("urx-output: {}", failure.message);
            ExitCode::from(failure.code)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An output that records what was written and can be made to fail.
    #[derive(Default)]
    struct Recorded {
        calls: Vec<String>,
        fail_root_mode: bool,
        extra: Vec<String>,
        changed: Vec<String>,
        fail_record: bool,
    }

    impl Output for Recorded {
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
            Ok(())
        }
        fn set_folder_mode(&mut self, path: &[String], mode: u32) -> io::Result<()> {
            if path.is_empty() && self.fail_root_mode {
                return Err(io::Error::other("denied"));
            }
            self.calls.push(format!("mode {} {mode:o}", path.join("/")));
            Ok(())
        }
        fn files(&mut self) -> io::Result<BTreeSet<String>> {
            let mut files: BTreeSet<String> = self
                .calls
                .iter()
                .filter_map(|call| {
                    call.strip_prefix("file ")
                        .map(|rest| rest.split(' ').next().unwrap_or("").to_owned())
                })
                .collect();
            files.extend(self.extra.iter().cloned());
            Ok(files)
        }
        fn holds(&mut self, path: &[String], _source: &Path) -> io::Result<bool> {
            Ok(!self.changed.contains(&path.join("/")))
        }
        fn write_record(&mut self, name: &str, bytes: &[u8], mode: u32) -> io::Result<()> {
            if self.fail_record {
                return Err(io::Error::other("short write"));
            }
            self.calls.push(format!(
                "record {name} {} {mode:o}",
                String::from_utf8_lossy(bytes)
            ));
            Ok(())
        }
        fn still_in_place(&mut self) -> io::Result<bool> {
            Ok(true)
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
    fn writes_folders_and_files_then_modes_then_the_record() {
        let (root, entries) = staging();
        let mut output = Recorded::default();
        publish(&mut output, &entries, 0o755, Some("record.json")).unwrap();
        let modes = if cfg!(unix) {
            ["644", "755", "644", "755"]
        } else {
            ["0", "0", "0", "0"]
        };
        assert_eq!(
            output.calls,
            vec![
                format!("file a.txt a {}", modes[0]),
                "folder app".to_owned(),
                format!("file app/main.js cli {}", modes[2]),
                format!("mode app {}", modes[1]),
                "mode  755".to_owned(),
                format!("record record.json record {}", modes[2]),
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_no_record_beside_a_file_it_did_not_write() {
        let (root, entries) = staging();
        let mut output = Recorded {
            extra: vec!["notes.txt".to_owned()],
            ..Recorded::default()
        };
        let failure = publish(&mut output, &entries, 0o755, Some("record.json")).unwrap_err();
        assert_eq!(
            failure.message,
            "the output holds files this build did not write, left as they are: notes.txt"
        );
        assert!(!output.calls.iter().any(|call| call.starts_with("record ")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_no_record_when_the_output_mode_cannot_be_set() {
        let (root, entries) = staging();
        let mut output = Recorded {
            fail_root_mode: true,
            ..Recorded::default()
        };
        assert!(publish(&mut output, &entries, 0o755, Some("record.json")).is_err());
        assert!(!output.calls.iter().any(|call| call.starts_with("record ")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn writes_no_record_when_a_written_file_changed() {
        let (root, entries) = staging();
        let mut output = Recorded {
            changed: vec!["app/main.js".to_owned()],
            ..Recorded::default()
        };
        let failure = publish(&mut output, &entries, 0o755, Some("record.json")).unwrap_err();
        assert_eq!(failure.message, "app/main.js changed after it was written");
        assert!(!output.calls.iter().any(|call| call.starts_with("record ")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fails_when_the_record_cannot_be_written() {
        let (root, entries) = staging();
        let mut output = Recorded {
            fail_record: true,
            ..Recorded::default()
        };
        assert!(publish(&mut output, &entries, 0o755, Some("record.json")).is_err());
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
    fn refuses_a_record_that_was_not_staged() {
        let (root, entries) = staging();
        let mut output = Recorded::default();
        let failure = publish(&mut output, &entries, 0o755, Some("missing.json")).unwrap_err();
        assert_eq!(failure.message, "the staged output holds no missing.json");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reads_its_command_line() {
        assert_eq!(run(&[]).unwrap_err().code, 2);
        assert_eq!(
            run(&[
                "publish".into(),
                "s".into(),
                "o".into(),
                "i".into(),
                "--first".into(),
                "x".into()
            ])
            .unwrap_err()
            .code,
            2
        );
    }
}
