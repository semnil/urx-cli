//! The two records maintenance reads: the release manifest a distribution
//! carries (immutable input) and the one mutable state record beside the gate
//! (K38). Each is taken only in exactly the form its writer gives it.

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use urx_launcher::install::{FORMAT, PRODUCT};

/// The name of the release manifest in a bundle; it is owned too.
pub const MANIFEST: &str = "release-manifest.json";

/// The files a bundle needs for the launcher, the CLI, its addon and its
/// removal (K18, K20), as the installer build requires them.
pub const REQUIRED: [&str; 5] = [
    "bin/urx",
    "runtime/node",
    "native/urx-native.node",
    "app/main.js",
    "maintenance/urx-uninstall",
];

/// The suffix of a file maintenance writes before renaming it into place;
/// no owned path ends with it.
pub const PENDING_SUFFIX: &str = ".urx-pending";

/// The SHA-256 of `bytes`, in lowercase hexadecimal.
pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn is_digest(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A relative path of an owned file: `/`-separated names of printable ASCII,
/// none empty, `.` or `..`, and none ending with the pending suffix. ASCII
/// alone leaves no two spellings of one name but its letter case, which
/// `key` folds: a file system that ignores Unicode normalization or case
/// then finds each owned file under one name only.
pub fn is_owned_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && path.bytes().all(|byte| (0x20..0x7f).contains(&byte))
        && path.split('/').all(|name| {
            !name.is_empty()
                && name != "."
                && name != ".."
                && name.len() <= 255
                && !name.ends_with(PENDING_SUFFIX)
        })
}

/// The name by which a file system that ignores letter case finds `path`.
pub fn key(path: &str) -> String {
    path.to_ascii_lowercase()
}

/// Each path names one file, whatever the letter case (macOS file systems
/// usually ignore it); no path is the folder of another (`a` and `a/b`
/// cannot both be files); and each folder is spelled one way only, so that
/// the files of one folder are never split across two spellings of it.
fn one_file_each(paths: &[String]) -> bool {
    let folded: std::collections::BTreeSet<String> = paths.iter().map(|path| key(path)).collect();
    let mut folders = std::collections::BTreeMap::<String, &str>::new();
    for path in paths {
        for (at, _) in path.match_indices('/') {
            let folder = &path[..at];
            if *folders.entry(key(folder)).or_insert(folder) != folder {
                return false;
            }
        }
    }
    folded.len() == paths.len()
        && folded.iter().all(|path| {
            path.match_indices('/')
                .all(|(at, _)| !folded.contains(&path[..at]))
        })
}

fn is_release(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'+'))
}

fn exact_keys(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.len() == keys.len() && keys.iter().all(|key| object.contains_key(*key))
}

/// One file of a release, as its manifest lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseFile {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

/// A release manifest: its release and its files.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Manifest {
    pub release: String,
    pub files: Vec<ReleaseFile>,
}

impl Manifest {
    /// Reads a release manifest of this product and format whose files each
    /// have a valid path, named once, with the required files among them.
    /// Its identity fields other than the release are not maintenance's.
    pub fn parse(bytes: &[u8]) -> Option<Manifest> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let object = value.as_object()?;
        if object.get("product")?.as_str()? != PRODUCT || object.get("format")?.as_u64()? != FORMAT
        {
            return None;
        }
        let release = object.get("release")?.as_str()?;
        if !is_release(release) {
            return None;
        }
        let mut files = Vec::new();
        for file in object.get("files")?.as_array()? {
            let file = file.as_object()?;
            if !exact_keys(file, &["path", "sha256", "size"]) {
                return None;
            }
            let path = file.get("path")?.as_str()?;
            let sha256 = file.get("sha256")?.as_str()?;
            let size = file.get("size")?.as_u64()?;
            if !is_owned_path(path) || path == MANIFEST || !is_digest(sha256) {
                return None;
            }
            files.push(ReleaseFile {
                path: path.to_owned(),
                sha256: sha256.to_owned(),
                size,
            });
        }
        let mut unique: Vec<String> = files.iter().map(|file| file.path.clone()).collect();
        unique.sort_unstable();
        if !one_file_each(&unique) {
            return None;
        }
        if !REQUIRED
            .iter()
            .all(|required| unique.binary_search(&(*required).to_owned()).is_ok())
        {
            return None;
        }
        Some(Manifest {
            release: release.to_owned(),
            files,
        })
    }

    /// The files an installation of this release owns: every listed file and
    /// the manifest itself, sorted.
    pub fn owned(&self) -> Vec<String> {
        let mut owned: Vec<String> = self.files.iter().map(|file| file.path.clone()).collect();
        owned.push(MANIFEST.to_owned());
        owned.sort_unstable();
        owned
    }
}

/// The phases maintenance writes (K38).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    Installing,
    Complete,
    Removing,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Phase::Installing => "installing",
            Phase::Complete => "complete",
            Phase::Removing => "removing",
        }
    }
}

/// The state record on macOS: the phase, the target release and the SHA-256
/// of its manifest, and every path the installation may own. While
/// installing, `owned` also holds the previous release's paths, so that an
/// interrupted update still removes the files only that release had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub phase: Phase,
    pub release: String,
    pub manifest: String,
    pub owned: Vec<String>,
}

impl State {
    /// Reads a state record in exactly the form `to_bytes` writes, its owned
    /// paths sorted, unique and including the manifest.
    pub fn parse(bytes: &[u8]) -> Option<State> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let object = value.as_object()?;
        if !exact_keys(
            object,
            &["product", "format", "phase", "release", "manifest", "owned"],
        ) {
            return None;
        }
        if object.get("product")?.as_str()? != PRODUCT || object.get("format")?.as_u64()? != FORMAT
        {
            return None;
        }
        let phase = match object.get("phase")?.as_str()? {
            "installing" => Phase::Installing,
            "complete" => Phase::Complete,
            "removing" => Phase::Removing,
            _ => return None,
        };
        let release = object.get("release")?.as_str()?;
        let manifest = object.get("manifest")?.as_str()?;
        if !is_release(release) || !is_digest(manifest) {
            return None;
        }
        let mut owned = Vec::new();
        for path in object.get("owned")?.as_array()? {
            let path = path.as_str()?;
            if !is_owned_path(path) {
                return None;
            }
            owned.push(path.to_owned());
        }
        let sorted_unique = owned.windows(2).all(|pair| pair[0] < pair[1]);
        if !sorted_unique || owned.binary_search(&MANIFEST.to_owned()).is_err() {
            return None;
        }
        Some(State {
            phase,
            release: release.to_owned(),
            manifest: manifest.to_owned(),
            owned,
        })
    }

    /// The record's bytes: the fields the launcher reads (K38) and the owned
    /// paths, sorted.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut owned = self.owned.clone();
        owned.sort_unstable();
        owned.dedup();
        let value = serde_json::json!({
            "product": PRODUCT,
            "format": FORMAT,
            "phase": self.phase.name(),
            "release": self.release,
            "manifest": self.manifest,
            "owned": owned,
        });
        let mut bytes = serde_json::to_vec_pretty(&value).expect("a JSON value serializes");
        bytes.push(b'\n');
        bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_with(files: Value) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "product": "urx-cli",
            "format": 1,
            "release": "0.1.0",
            "app": { "version": "0.1.0", "commit": "a" },
            "files": files,
        }))
        .unwrap()
    }

    fn file(path: &str) -> Value {
        serde_json::json!({ "path": path, "sha256": "0".repeat(64), "size": 1 })
    }

    fn required() -> Vec<Value> {
        REQUIRED.iter().map(|path| file(path)).collect()
    }

    #[test]
    fn a_manifest_lists_its_files_and_owns_itself() {
        let mut files = required();
        files.push(file("notices/LICENSE"));
        let manifest = Manifest::parse(&manifest_with(Value::Array(files))).unwrap();
        assert_eq!(manifest.release, "0.1.0");
        let owned = manifest.owned();
        assert!(
            owned.contains(&MANIFEST.to_owned()) && owned.contains(&"notices/LICENSE".to_owned())
        );
        assert!(owned.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn a_manifest_in_any_other_form_is_refused() {
        let with = |extra: Value| {
            let mut files = required();
            files.push(extra);
            manifest_with(Value::Array(files))
        };
        for bytes in [
            manifest_with(Value::Array(
                REQUIRED[1..].iter().map(|path| file(path)).collect(),
            )),
            with(file("bin/urx")),
            with(file("../outside")),
            with(file("/absolute")),
            with(file("a//b")),
            with(file("./a")),
            with(file(MANIFEST)),
            with(file("bin/urx/inside")),
            with(file("app/main.js/inside")),
            with(file("App/main.js")),
            with(file("BIN/URX")),
            with(file("a.urx-pending/b")),
            with(file("caf\u{e9}")),
            with(file("App/other.js")),
            with(file("a.urx-pending")),
            with(file("line\nbreak")),
            with(serde_json::json!({ "path": "x", "sha256": "0".repeat(63), "size": 1 })),
            with(serde_json::json!({ "path": "x", "sha256": "A".repeat(64), "size": 1 })),
            with(serde_json::json!({ "path": "x", "sha256": "0".repeat(64), "size": -1 })),
            with(
                serde_json::json!({ "path": "x", "sha256": "0".repeat(64), "size": 1, "mode": 1 }),
            ),
            br#"{"product":"other","format":1,"release":"0.1.0","files":[]}"#.to_vec(),
            br#"[]"#.to_vec(),
            b"not json".to_vec(),
        ] {
            assert_eq!(
                Manifest::parse(&bytes),
                None,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
        // A file and a folder of the same name, with a name between them in sorted order.
        let mut files = required();
        files.extend([file("notices"), file("notices-x"), file("notices/y")]);
        assert_eq!(Manifest::parse(&manifest_with(Value::Array(files))), None);
    }

    fn state(phase: Phase) -> State {
        State {
            phase,
            release: "0.1.0".to_owned(),
            manifest: "a".repeat(64),
            owned: vec!["bin/urx".to_owned(), MANIFEST.to_owned()],
        }
    }

    #[test]
    fn a_state_record_reads_back_as_written_and_the_launcher_takes_a_complete_one() {
        for phase in [Phase::Installing, Phase::Complete, Phase::Removing] {
            let record = state(phase);
            assert_eq!(State::parse(&record.to_bytes()), Some(record));
        }
        let manifest = b"{}";
        let complete = State {
            manifest: digest(manifest),
            ..state(Phase::Complete)
        };
        assert_eq!(
            urx_launcher::install::check(&complete.to_bytes(), manifest),
            Ok(())
        );
        let installing = State {
            phase: Phase::Installing,
            ..complete
        };
        assert!(urx_launcher::install::check(&installing.to_bytes(), manifest).is_err());
    }

    #[test]
    fn a_state_record_in_any_other_form_is_refused() {
        let base = serde_json::json!({
            "product": "urx-cli", "format": 1, "phase": "complete", "release": "0.1.0",
            "manifest": "a".repeat(64), "owned": ["bin/urx", MANIFEST],
        });
        let changed = |key: &str, value: Value| {
            let mut record = base.clone();
            record[key] = value;
            serde_json::to_vec(&record).unwrap()
        };
        let mut extra = base.clone();
        extra["pathAdded"] = Value::Bool(false);
        for bytes in [
            changed("phase", Value::from("installed")),
            changed("product", Value::from("other")),
            changed("format", Value::from(2)),
            changed("release", Value::from("")),
            changed("manifest", Value::from("a".repeat(63))),
            changed("owned", serde_json::json!(["bin/urx"])),
            changed("owned", serde_json::json!([MANIFEST, "bin/urx"])),
            changed("owned", serde_json::json!(["bin/urx", "bin/urx", MANIFEST])),
            changed("owned", serde_json::json!(["../x", MANIFEST])),
            serde_json::to_vec(&extra).unwrap(),
            b"{}".to_vec(),
            Vec::new(),
        ] {
            assert_eq!(
                State::parse(&bytes),
                None,
                "{}",
                String::from_utf8_lossy(&bytes)
            );
        }
    }
}
