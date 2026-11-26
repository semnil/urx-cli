//! The installation the launcher starts (K18, K38): its fixed maintenance
//! directory, the bundle the launcher itself belongs to, and the check that
//! the installation state says this bundle is complete. Nothing here repairs
//! or recreates state; an installation that is not complete never runs.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The state record's product and format (K38).
const PRODUCT: &str = "urx-cli";
const FORMAT: u64 = 1;

/// The files of one installed bundle, located from the launcher's own path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
    pub root: PathBuf,
}

impl Bundle {
    /// The bundle whose `bin` directory holds `launcher`.
    pub fn of_launcher(launcher: &Path) -> Option<Bundle> {
        let bin = launcher.parent()?;
        if bin.file_name()? != "bin" {
            return None;
        }
        Some(Bundle {
            root: bin.parent()?.to_path_buf(),
        })
    }

    /// The bundled Node executable.
    pub fn runtime(&self) -> PathBuf {
        self.root
            .join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    }

    /// The compiled CLI's entry script.
    pub fn entry(&self) -> PathBuf {
        self.root.join("app").join("main.js")
    }

    /// The release manifest the state record names by its digest.
    pub fn manifest(&self) -> PathBuf {
        self.root.join("release-manifest.json")
    }
}

/// The state record beside the gate.
pub fn state_path(maintenance: &Path) -> PathBuf {
    maintenance.join("state.json")
}

/// Why the installation is not one the launcher starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallFailure {
    /// The state is missing, malformed, of another product or format, not complete,
    /// or names another release manifest than this bundle's; or a bundle file is missing.
    Incomplete,
}

/// Checks the state record against the bundle: product and format known, phase
/// `complete`, and the manifest digest that of this bundle's release manifest.
pub fn check(state: &[u8], manifest: &[u8]) -> Result<(), InstallFailure> {
    let record: serde_json::Value =
        serde_json::from_slice(state).map_err(|_| InstallFailure::Incomplete)?;
    let product = record.get("product").and_then(serde_json::Value::as_str);
    let format = record.get("format").and_then(serde_json::Value::as_u64);
    let phase = record.get("phase").and_then(serde_json::Value::as_str);
    let digest = record.get("manifest").and_then(serde_json::Value::as_str);
    if product != Some(PRODUCT) || format != Some(FORMAT) || phase != Some("complete") {
        return Err(InstallFailure::Incomplete);
    }
    let actual = Sha256::digest(manifest);
    let actual: String = actual.iter().map(|byte| format!("{byte:02x}")).collect();
    if digest != Some(actual.as_str()) {
        return Err(InstallFailure::Incomplete);
    }
    Ok(())
}

/// Reads the state and the bundle's manifest and checks them, and that the
/// runtime and the entry script exist.
pub fn verify(maintenance: &Path, bundle: &Bundle) -> Result<(), InstallFailure> {
    let state = read_regular(&state_path(maintenance)).map_err(|_| InstallFailure::Incomplete)?;
    let manifest = read_regular(&bundle.manifest()).map_err(|_| InstallFailure::Incomplete)?;
    check(&state, &manifest)?;
    if !bundle.runtime().is_file() || !bundle.entry().is_file() {
        return Err(InstallFailure::Incomplete);
    }
    Ok(())
}

/// The contents of `path` when it is a regular file. It is opened without
/// waiting (a FIFO in its place has no writer to wait for) and the open
/// file's own type is checked before anything is read.
fn read_regular(path: &Path) -> std::io::Result<Vec<u8>> {
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput));
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest(bytes: &[u8]) -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn state(product: &str, format: u64, phase: &str, manifest: &str) -> Vec<u8> {
        serde_json::json!({ "product": product, "format": format, "phase": phase, "manifest": manifest, "release": "0.1.0" })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn a_complete_state_naming_this_manifest_is_accepted() {
        let manifest = br#"{"files":[]}"#;
        assert_eq!(
            check(
                &state(PRODUCT, FORMAT, "complete", &digest(manifest)),
                manifest
            ),
            Ok(())
        );
    }

    #[test]
    fn any_other_state_is_incomplete() {
        let manifest = br#"{"files":[]}"#;
        let good = digest(manifest);
        for record in [
            state(PRODUCT, FORMAT, "installing", &good),
            state(PRODUCT, FORMAT, "removing", &good),
            state("other", FORMAT, "complete", &good),
            state(PRODUCT, 2, "complete", &good),
            state(PRODUCT, FORMAT, "complete", &digest(b"another manifest")),
            state(PRODUCT, FORMAT, "complete", &good.to_uppercase()),
            b"not json".to_vec(),
            b"[]".to_vec(),
            Vec::new(),
        ] {
            assert_eq!(
                check(&record, manifest),
                Err(InstallFailure::Incomplete),
                "{}",
                String::from_utf8_lossy(&record)
            );
        }
    }

    #[test]
    fn the_bundle_is_the_parent_of_the_launchers_bin_directory() {
        let bundle = Bundle::of_launcher(Path::new("/usr/local/lib/urx-cli/bin/urx")).unwrap();
        assert_eq!(bundle.root, Path::new("/usr/local/lib/urx-cli"));
        assert_eq!(
            bundle.entry(),
            Path::new("/usr/local/lib/urx-cli/app/main.js")
        );
        assert_eq!(
            Bundle::of_launcher(Path::new("/usr/local/lib/urx-cli/urx")),
            None
        );
    }
}
