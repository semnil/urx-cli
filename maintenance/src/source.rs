//! The distribution an installer installs from: the release tree beside
//! `urx-install` in the disk image (K41). It is taken only when its release
//! manifest is the one the installer was built for, and the tree holds
//! exactly the files that manifest lists, each as listed, with the modes the
//! bundle is built with.

use crate::records::{digest, Manifest, MANIFEST};
use crate::sys::{self, Fd};
use crate::tree::{self, WalkError};
use crate::Problem;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The files run as programs (0755); every other file is 0644 (K18).
pub const EXECUTABLES: [&str; 3] = ["bin/urx", "runtime/node", "maintenance/urx-uninstall"];

/// The longest release manifest read.
const MANIFEST_LIMIT: u64 = 8 << 20;

/// A verified distribution.
#[derive(Debug)]
pub struct Source {
    pub path: PathBuf,
    pub root: Fd,
    pub manifest_bytes: Vec<u8>,
    pub manifest: Manifest,
    /// The mode each owned file is installed with.
    pub modes: BTreeMap<String, u32>,
}

impl Source {
    /// The SHA-256 of the release manifest, which the state record names.
    pub fn digest(&self) -> String {
        digest(&self.manifest_bytes)
    }
}

/// The mode an owned file has in a bundle.
pub fn mode_of(path: &str) -> u32 {
    if EXECUTABLES.contains(&path) {
        0o755
    } else {
        0o644
    }
}

/// Verifies the tree at `path` against `expected`, the SHA-256 of the release
/// manifest the installer was built for. Nothing is written.
pub fn verify(path: &Path, expected: &str) -> Result<Source, Problem> {
    let invalid = |why: &str| Problem::Source(format!("{}: {why}", path.display()));
    let root =
        sys::open_system_folder(path).map_err(|_| invalid("the release files cannot be opened"))?;
    let (file, entry) = sys::open_file_at(&root, &crate::place::name(MANIFEST))
        .map_err(|_| invalid("the release manifest cannot be read"))?;
    if entry.size > MANIFEST_LIMIT {
        return Err(invalid("the release manifest cannot be read"));
    }
    let mut manifest_bytes = Vec::new();
    file.take(MANIFEST_LIMIT + 1)
        .read_to_end(&mut manifest_bytes)
        .map_err(|_| invalid("the release manifest cannot be read"))?;
    if digest(&manifest_bytes) != expected {
        return Err(invalid(
            "the release manifest is not the one this installer was built for",
        ));
    }
    let manifest = Manifest::parse(&manifest_bytes)
        .ok_or_else(|| invalid("the release manifest cannot be read"))?;
    if entry.mode != 0o644 {
        return Err(invalid(
            "the release manifest does not have the mode it is built with",
        ));
    }
    let found = tree::files(&root).map_err(|error| match error {
        WalkError::Conflict(at) => invalid(&format!("{at} is not a regular file or a folder")),
        WalkError::Io(_) => invalid("the release files cannot be read"),
    })?;
    if found != manifest.owned() {
        return Err(invalid(
            "the release files are not exactly those its manifest lists",
        ));
    }
    let mut modes = BTreeMap::new();
    for file in &manifest.files {
        let mode = mode_of(&file.path);
        let (sha256, size, actual_mode) = read_file(&root, &file.path)
            .map_err(|_| invalid(&format!("{} cannot be read", file.path)))?;
        if sha256 != file.sha256 || size != file.size {
            return Err(invalid(&format!(
                "{} is not the file its manifest lists",
                file.path
            )));
        }
        if actual_mode != mode {
            return Err(invalid(&format!(
                "{} does not have the mode it is built with",
                file.path
            )));
        }
        modes.insert(file.path.clone(), mode);
    }
    modes.insert(MANIFEST.to_owned(), 0o644);
    Ok(Source {
        path: path.to_path_buf(),
        root,
        manifest_bytes,
        manifest,
        modes,
    })
}

/// The SHA-256, size and mode of the regular file at `path` under `root`.
fn read_file(root: &Fd, path: &str) -> Result<(String, u64, u32), WalkError> {
    let (parent, name) =
        tree::parent_of(root, path, None, false)?.ok_or(WalkError::Conflict(path.to_owned()))?;
    let (mut file, entry) = sys::open_file_at(&parent, &name)?;
    let (sha256, size) = tree::hash(&mut file)?;
    Ok((sha256, size, entry.mode))
}
