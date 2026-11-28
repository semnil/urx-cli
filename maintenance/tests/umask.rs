//! The modes an installation gets whatever the umask. The umask is the
//! process's, so this file holds this one test.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use urx_maintenance::install::install;
use urx_maintenance::place::Layout;
use urx_maintenance::records::{digest, MANIFEST};

#[test]
fn every_folder_and_file_an_apply_makes_has_its_mode_under_a_strict_umask() {
    let base = std::env::temp_dir().join(format!("urx-maintenance-umask-{}", std::process::id()));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("Library")).unwrap();
    let source = base.join("image/urx-cli");
    let mut listed = Vec::new();
    for (path, mode) in [
        ("bin/urx", 0o755),
        ("runtime/node", 0o755),
        ("native/urx-native.node", 0o644),
        ("app/main.js", 0o644),
        ("maintenance/urx-uninstall", 0o755),
    ] {
        let at = source.join(path);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&at, path).unwrap();
        fs::set_permissions(&at, fs::Permissions::from_mode(mode)).unwrap();
        listed.push(serde_json::json!({ "path": path, "sha256": digest(path.as_bytes()), "size": path.len() }));
    }
    let manifest = serde_json::to_vec(&serde_json::json!({ "product": "urx-cli", "format": 1, "release": "0.1.0", "files": listed })).unwrap();
    fs::write(source.join(MANIFEST), &manifest).unwrap();
    fs::set_permissions(source.join(MANIFEST), fs::Permissions::from_mode(0o644)).unwrap();
    let layout = Layout {
        root: base.join("usr/local/lib/urx-cli"),
        link: base.join("usr/local/bin/urx"),
        maintenance: base.join("Library/urx-cli-maintenance"),
        // SAFETY: geteuid has no preconditions.
        owner: unsafe { libc::geteuid() },
        top: base.clone(),
    };
    // SAFETY: umask has no preconditions; this test is the only one in its process.
    let previous = unsafe { libc::umask(0o077) };
    let result = install(&layout, &source, &digest(&manifest), true, &|| false);
    // SAFETY: as above.
    unsafe { libc::umask(previous) };
    result.unwrap();
    let mode =
        |path: &std::path::Path| fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777;
    for folder in [
        "usr",
        "usr/local",
        "usr/local/lib",
        "usr/local/bin",
        "usr/local/lib/urx-cli",
        "usr/local/lib/urx-cli/app",
        "Library/urx-cli-maintenance",
    ] {
        assert_eq!(mode(&base.join(folder)), 0o755, "{folder}");
    }
    assert_eq!(mode(&layout.maintenance.join("gate.lock")), 0o644);
    assert_eq!(mode(&layout.maintenance.join("state.json")), 0o644);
    assert_eq!(mode(&layout.root.join("app/main.js")), 0o644);
    assert_eq!(mode(&layout.root.join("bin/urx")), 0o755);
    let _ = fs::remove_dir_all(&base);
}
