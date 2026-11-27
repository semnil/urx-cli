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

/// The start of the names maintenance keeps for itself inside a tree it
/// makes (its journal, and each entry before it is moved to its path): no
/// name of an owned path starts with it, in any letter case.
pub const RESERVED_PREFIX: &str = ".urx-";

/// The pending sibling's tag: the start of the manifest digest of the
/// release it is written for. A pending name is maintenance's only with the
/// tag of the release maintenance is installing or removing, never by its
/// place alone.
pub fn pending_tag(manifest_digest: &str) -> &str {
    &manifest_digest[..16.min(manifest_digest.len())]
}

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
/// none empty, `.` or `..`, none holding the pending suffix and none
/// starting with the reserved prefix in any letter case. ASCII
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
                && !name.contains(PENDING_SUFFIX)
                && !key(name).starts_with(RESERVED_PREFIX)
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

/// A work folder beside the root (K41 as revised): its name, which object
/// it is (its inode), the files it may hold, and whether what it holds is
/// told by its journal (`check`: a release being assembled, of which only
/// what the journal names is the installation's) or by the list (the
/// previous tree, swapped out of the root).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Work {
    pub name: String,
    pub id: u64,
    pub files: Vec<String>,
    pub check: bool,
}

/// The state record on macOS: the phase, the target release and the SHA-256
/// of its manifest, and the files the installation may own.
/// Each object is named by its inode, on the volume of the root's parent.
/// - `complete`: `owned` is the release's files, at the root, whose object
///   is `root`.
/// - `installing`: `owned` is the release's files and `base` those of the
///   tree at the root the run started from, whose object is `previous`
///   (none for a first installation); `work`, once made, is the work folder
///   the release is assembled in. Which object is at the root, and which at
///   the work folder's name, is read from the objects themselves.
/// - `removing`: `owned` is the files of the tree at the root when the
///   removal began, whose object is `root` (none when there was none), and
///   `work` the work folder left beside it, if any.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct State {
    pub phase: Phase,
    pub release: String,
    pub manifest: String,
    pub owned: Vec<String>,
    /// Present exactly while installing.
    pub base: Option<Vec<String>>,
    /// Only while installing.
    pub previous: Option<u64>,
    /// Present once complete; while removing, when there was a root.
    pub root: Option<u64>,
    /// Absent once complete.
    pub work: Option<Work>,
}

fn sorted_paths(value: &Value) -> Option<Vec<String>> {
    let mut paths = Vec::new();
    for path in value.as_array()? {
        let path = path.as_str()?;
        if !is_owned_path(path) {
            return None;
        }
        paths.push(path.to_owned());
    }
    paths
        .windows(2)
        .all(|pair| pair[0] < pair[1])
        .then_some(paths)
}

fn sorted(paths: &[String]) -> Vec<String> {
    let mut paths = paths.to_vec();
    paths.sort_unstable();
    paths.dedup();
    paths
}

/// An object's inode, in exactly the form `to_bytes` writes it.
fn inode_of(value: &Value) -> Option<u64> {
    let value = value.as_object()?;
    if !exact_keys(value, &["inode"]) {
        return None;
    }
    value.get("inode")?.as_u64()
}

fn inode_value(inode: u64) -> Value {
    serde_json::json!({ "inode": inode })
}

/// A work folder's name: one name, of printable ASCII.
fn is_folder_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|byte| (0x21..0x7f).contains(&byte) && byte != b'/')
}

impl State {
    /// Reads a state record in exactly the form `to_bytes` writes for its
    /// phase, its paths sorted, unique, and `owned` including the manifest
    /// unless removing.
    pub fn parse(bytes: &[u8]) -> Option<State> {
        let value: Value = serde_json::from_slice(bytes).ok()?;
        let object = value.as_object()?;
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
        let mut keys = vec!["product", "format", "phase", "release", "manifest", "owned"];
        match phase {
            Phase::Installing => {
                keys.push("base");
                if object.contains_key("previous") {
                    keys.push("previous");
                }
            }
            Phase::Complete => keys.push("root"),
            Phase::Removing => {
                if object.contains_key("root") {
                    keys.push("root");
                }
            }
        }
        if phase != Phase::Complete && object.contains_key("work") {
            keys.push("work");
        }
        if !exact_keys(object, &keys) {
            return None;
        }
        let release = object.get("release")?.as_str()?;
        let manifest = object.get("manifest")?.as_str()?;
        if !is_release(release) || !is_digest(manifest) {
            return None;
        }
        let owned = sorted_paths(object.get("owned")?)?;
        if phase != Phase::Removing && owned.binary_search(&MANIFEST.to_owned()).is_err() {
            return None;
        }
        let base = match object.get("base") {
            Some(base) => Some(sorted_paths(base)?),
            None => None,
        };
        let previous = match object.get("previous") {
            Some(previous) => Some(inode_of(previous)?),
            None => None,
        };
        let root = match object.get("root") {
            Some(root) => Some(inode_of(root)?),
            None => None,
        };
        let work = match object.get("work") {
            Some(work) => {
                let fields = work.as_object()?;
                if !exact_keys(fields, &["name", "inode", "files", "check"]) {
                    return None;
                }
                let name = fields.get("name")?.as_str()?;
                if !is_folder_name(name) {
                    return None;
                }
                Some(Work {
                    name: name.to_owned(),
                    id: fields.get("inode")?.as_u64()?,
                    files: sorted_paths(fields.get("files")?)?,
                    check: fields.get("check")?.as_bool()?,
                })
            }
            None => None,
        };
        Some(State {
            phase,
            release: release.to_owned(),
            manifest: manifest.to_owned(),
            owned,
            base,
            previous,
            root,
            work,
        })
    }

    /// The record's bytes: the fields the launcher reads (K38), the files,
    /// and the fields of the phase.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut value = serde_json::json!({
            "product": PRODUCT,
            "format": FORMAT,
            "phase": self.phase.name(),
            "release": self.release,
            "manifest": self.manifest,
            "owned": sorted(&self.owned),
        });
        if let Some(base) = &self.base {
            value["base"] = serde_json::json!(sorted(base));
        }
        if let Some(previous) = self.previous {
            value["previous"] = inode_value(previous);
        }
        if let Some(root) = self.root {
            value["root"] = inode_value(root);
        }
        if let Some(work) = &self.work {
            value["work"] = serde_json::json!({
                "name": work.name,
                "inode": work.id,
                "files": sorted(&work.files),
                "check": work.check,
            });
        }
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
            base: (phase == Phase::Installing).then(|| vec!["bin/urx".to_owned()]),
            previous: (phase == Phase::Installing).then_some(4),
            root: (phase != Phase::Installing).then_some(5),
            work: (phase != Phase::Complete).then(|| Work {
                name: "urx-cli.install-0".to_owned(),
                id: 2,
                files: vec!["bin/urx".to_owned()],
                check: true,
            }),
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
            base: Some(Vec::new()),
            root: None,
            ..complete
        };
        assert!(urx_launcher::install::check(&installing.to_bytes(), manifest).is_err());
    }

    #[test]
    fn a_state_record_in_any_other_form_is_refused() {
        let base = serde_json::json!({
            "product": "urx-cli", "format": 1, "phase": "complete", "release": "0.1.0",
            "manifest": "a".repeat(64), "owned": ["bin/urx", MANIFEST], "root": { "inode": 1 },
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
            // `base` and `previous` only while installing, `work` only while not complete.
            changed("base", serde_json::json!([])),
            changed("previous", serde_json::json!({ "inode": 2 })),
            changed(
                "work",
                serde_json::json!({ "name": "w", "inode": 2, "files": [], "check": true }),
            ),
            // An object is named by its inode alone; `complete` names its root.
            changed("root", serde_json::json!({ "device": 1, "inode": 2 })),
            changed("root", serde_json::json!(2)),
            {
                let mut record = base.clone();
                record.as_object_mut().unwrap().remove("root");
                serde_json::to_vec(&record).unwrap()
            },
            {
                let mut record = base.clone();
                record["phase"] = Value::from("installing");
                record["base"] = serde_json::json!([]);
                serde_json::to_vec(&record).unwrap()
            },
            {
                let mut record = base.clone();
                record["phase"] = Value::from("removing");
                record["work"] = serde_json::json!({ "name": "w", "device": 1, "inode": 2, "files": [], "check": true });
                serde_json::to_vec(&record).unwrap()
            },
            // No owned name is one maintenance keeps for itself.
            changed("owned", serde_json::json!([".urx-new-1", MANIFEST])),
            changed(
                "owned",
                serde_json::json!(["bin/.URX-journal", "bin/urx", MANIFEST]),
            ),
            {
                let mut record = base.clone();
                record["phase"] = Value::from("installing");
                serde_json::to_vec(&record).unwrap()
            },
            {
                let mut record = base.clone();
                record["phase"] = Value::from("removing");
                record["base"] = serde_json::json!(["bin/urx"]);
                serde_json::to_vec(&record).unwrap()
            },
            {
                let mut record = base.clone();
                record["phase"] = Value::from("removing");
                record["work"] = serde_json::json!({ "name": "a/b", "device": 1, "inode": 2, "files": [], "check": true });
                serde_json::to_vec(&record).unwrap()
            },
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
