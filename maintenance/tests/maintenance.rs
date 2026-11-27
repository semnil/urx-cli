//! Installation, update, repair and removal in folders of the test's own,
//! with the test's user as the owner the fixed layout gives root.
#![cfg(unix)]

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use urx_maintenance::install::install;
use urx_maintenance::place::Layout;
use urx_maintenance::records::{digest, Phase, State, MANIFEST};
use urx_maintenance::remove::uninstall;
use urx_maintenance::Problem;

/// One run of a tool with the stop it asks.
type Run<'a> = &'a dyn Fn(&dyn Fn() -> bool) -> Result<(), Problem>;
/// A change to a release tree.
type Change = Box<dyn Fn(&Path)>;

struct Scene {
    base: PathBuf,
    layout: Layout,
}

impl Drop for Scene {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

fn scene() -> Scene {
    static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let base = std::env::temp_dir().join(format!(
        "urx-maintenance-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
    ));
    let _ = fs::remove_dir_all(&base);
    fs::create_dir_all(base.join("Library")).unwrap();
    // The temporary folder may be writable by others; the fixed parents are not checked.
    let layout = Layout {
        root: base.join("usr/local/lib/urx-cli"),
        link: base.join("usr/local/bin/urx"),
        maintenance: base.join("Library/urx-cli-maintenance"),
        // SAFETY: geteuid has no preconditions.
        owner: unsafe { libc::geteuid() },
    };
    Scene { base, layout }
}

/// A release tree with `files` (path, contents) besides the required ones,
/// with the modes a bundle has; returns its path and manifest digest.
fn release(scene: &Scene, name: &str, version: &str, files: &[(&str, &str)]) -> (PathBuf, String) {
    let root = scene.base.join(name).join("urx-cli");
    let mut all: Vec<(String, String)> = vec![
        ("bin/urx".into(), format!("launcher {version}")),
        ("runtime/node".into(), "node".into()),
        ("native/urx-native.node".into(), "addon".into()),
        ("app/main.js".into(), format!("main {version}")),
        ("maintenance/urx-uninstall".into(), "uninstall".into()),
    ];
    all.extend(
        files
            .iter()
            .map(|(path, text)| ((*path).to_owned(), (*text).to_owned())),
    );
    let mut listed = Vec::new();
    for (path, text) in &all {
        let at = root.join(path);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&at, text).unwrap();
        let mode =
            if ["bin/urx", "runtime/node", "maintenance/urx-uninstall"].contains(&path.as_str()) {
                0o755
            } else {
                0o644
            };
        fs::set_permissions(&at, fs::Permissions::from_mode(mode)).unwrap();
        listed.push(serde_json::json!({ "path": path, "sha256": digest(text.as_bytes()), "size": text.len() }));
    }
    let manifest = serde_json::to_vec_pretty(&serde_json::json!({
        "product": "urx-cli", "format": 1, "release": version,
        "app": { "version": version, "commit": "c" }, "files": listed,
    }))
    .unwrap();
    fs::write(root.join(MANIFEST), &manifest).unwrap();
    fs::set_permissions(root.join(MANIFEST), fs::Permissions::from_mode(0o644)).unwrap();
    (root, digest(&manifest))
}

fn never() -> bool {
    false
}

fn state_of(scene: &Scene) -> Option<State> {
    fs::read(scene.layout.maintenance.join("state.json"))
        .ok()
        .map(|bytes| State::parse(&bytes).expect("a valid record"))
}

fn launcher_accepts(scene: &Scene) -> bool {
    let state = fs::read(scene.layout.maintenance.join("state.json")).unwrap_or_default();
    let manifest = fs::read(scene.layout.root.join(MANIFEST)).unwrap_or_default();
    urx_launcher::install::check(&state, &manifest).is_ok()
}

fn mode(path: &Path) -> u32 {
    fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
}

#[test]
fn a_preview_changes_nothing() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    let report = install(&scene.layout, &source, &expected, false, &never).unwrap();
    assert!(
        report.lines[0].starts_with("Would install urx-cli 0.1.0"),
        "{:?}",
        report.lines
    );
    assert!(!scene.layout.maintenance.exists());
    assert!(!scene.layout.root.exists());
    assert!(fs::symlink_metadata(&scene.layout.link).is_err());
}

#[test]
fn an_apply_installs_every_file_with_its_mode_links_the_command_and_records_complete() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let root = &scene.layout.root;
    assert_eq!(
        fs::read_to_string(root.join("bin/urx")).unwrap(),
        "launcher 0.1.0"
    );
    assert_eq!(mode(&root.join("bin/urx")), 0o755);
    assert_eq!(mode(&root.join("runtime/node")), 0o755);
    assert_eq!(mode(&root.join("maintenance/urx-uninstall")), 0o755);
    assert_eq!(mode(&root.join("notices/LICENSE")), 0o644);
    assert_eq!(mode(&root.join(MANIFEST)), 0o644);
    assert_eq!(mode(root), 0o755);
    assert_eq!(
        fs::read_link(&scene.layout.link).unwrap(),
        root.join("bin/urx")
    );
    let state = state_of(&scene).unwrap();
    assert_eq!(
        (state.phase, state.release.as_str()),
        (Phase::Complete, "0.1.0")
    );
    assert!(state.owned.contains(&"notices/LICENSE".to_owned()));
    assert!(launcher_accepts(&scene));
    let gate = scene.layout.maintenance.join("gate.lock");
    assert_eq!(fs::metadata(&gate).unwrap().len(), 0);
    assert_eq!(mode(&gate), 0o644);
    assert_eq!(mode(&scene.layout.maintenance), 0o755);
    // Nothing is left pending.
    let pending: Vec<_> = walk(root)
        .into_iter()
        .filter(|path| path.ends_with(".urx-pending"))
        .collect();
    assert!(pending.is_empty(), "{pending:?}");
}

fn walk(root: &Path) -> Vec<String> {
    let mut found = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in fs::read_dir(&folder).unwrap() {
            let path = entry.unwrap().path();
            if fs::symlink_metadata(&path).unwrap().is_dir() {
                stack.push(path);
            } else {
                found.push(
                    path.strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
    }
    found.sort();
    found
}

#[test]
fn the_same_release_repairs_a_changed_file_and_a_complete_record_names_only_its_files() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    fs::write(scene.layout.root.join("app/main.js"), "changed").unwrap();
    let report = install(&scene.layout, &source, &expected, true, &never).unwrap();
    assert!(
        report.lines[0].starts_with("Installed urx-cli 0.1.0 again"),
        "{:?}",
        report.lines
    );
    assert_eq!(
        fs::read_to_string(scene.layout.root.join("app/main.js")).unwrap(),
        "main 0.1.0"
    );
    assert!(launcher_accepts(&scene));
}

#[test]
fn an_update_removes_the_files_only_the_previous_release_had_and_their_empty_folders() {
    let scene = scene();
    let (old, old_digest) = release(
        &scene,
        "old",
        "0.1.0",
        &[("notices/OLD", "old"), ("app/gone/x.js", "x")],
    );
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    fs::write(scene.layout.root.join("notices/user-note"), "mine").unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[("notices/NEW", "new")]);
    let report = install(&scene.layout, &new, &new_digest, true, &never).unwrap();
    assert!(
        report.lines[0].starts_with("Updated urx-cli 0.1.0 to 0.2.0"),
        "{:?}",
        report.lines
    );
    let root = &scene.layout.root;
    assert!(!root.join("notices/OLD").exists());
    assert!(!root.join("app/gone").exists());
    assert_eq!(fs::read_to_string(root.join("notices/NEW")).unwrap(), "new");
    // A file the installation did not make is kept.
    assert_eq!(
        fs::read_to_string(root.join("notices/user-note")).unwrap(),
        "mine"
    );
    let state = state_of(&scene).unwrap();
    assert!(!state.owned.contains(&"notices/OLD".to_owned()));
    assert!(launcher_accepts(&scene));
}

/// Runs `run` with a stop that answers true from its `at`th question on;
/// returns how many questions were asked when it never stops.
fn questions(run: Run<'_>) -> usize {
    let asked = Cell::new(0);
    run(&|| {
        asked.set(asked.get() + 1);
        false
    })
    .unwrap();
    asked.get()
}

#[test]
fn an_installation_interrupted_at_any_point_blocks_the_cli_until_the_same_release_finishes_it() {
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
    let total =
        questions(&|stop| install(&probe.layout, &source, &expected, true, stop).map(|_| ()));
    assert!(total > 5, "{total}");
    for at in 1..=total {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
        let asked = Cell::new(0);
        let stop = || {
            asked.set(asked.get() + 1);
            asked.get() >= at
        };
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop),
            Err(Problem::Interrupted),
            "at {at}"
        );
        assert!(!launcher_accepts(&scene), "at {at}");
        match state_of(&scene) {
            // Interrupted before the record was written: nothing of the payload was changed.
            None => assert!(!scene.layout.root.exists(), "at {at}"),
            Some(state) => assert_eq!(state.phase, Phase::Installing, "at {at}"),
        }
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        assert!(launcher_accepts(&scene), "at {at}");
    }
}

#[test]
fn an_interrupted_update_is_finished_only_by_its_release_and_still_removes_the_old_files() {
    let scene = scene();
    let (old, old_digest) = release(&scene, "old", "0.1.0", &[("notices/OLD", "old")]);
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
    let asked = Cell::new(0);
    let stop = || {
        asked.set(asked.get() + 1);
        asked.get() >= 3
    };
    assert_eq!(
        install(&scene.layout, &new, &new_digest, true, &stop),
        Err(Problem::Interrupted)
    );
    assert_eq!(state_of(&scene).unwrap().phase, Phase::Installing);
    assert_eq!(
        install(&scene.layout, &old, &old_digest, true, &never),
        Err(Problem::Unfinished {
            release: "0.2.0".to_owned()
        })
    );
    install(&scene.layout, &new, &new_digest, true, &never).unwrap();
    assert!(!scene.layout.root.join("notices/OLD").exists());
    assert!(launcher_accepts(&scene));
}

#[test]
fn something_foreign_where_the_installation_goes_is_kept_and_stops_it() {
    // A root without a record.
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    fs::create_dir_all(&scene.layout.root).unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Unrecorded(scene.layout.root.clone()))
    );
    assert!(state_of(&scene).is_none());
    // A command link that points elsewhere.
    let scene = self::scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    fs::create_dir_all(scene.layout.link.parent().unwrap()).unwrap();
    symlink("/bin/sh", &scene.layout.link).unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Conflict(scene.layout.link.clone()))
    );
    assert_eq!(
        fs::read_link(&scene.layout.link).unwrap(),
        Path::new("/bin/sh")
    );
    // A folder where an owned file goes, and a link where an owned folder is.
    let scene = self::scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    fs::remove_file(scene.layout.root.join("app/main.js")).unwrap();
    fs::create_dir(scene.layout.root.join("app/main.js")).unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Conflict(scene.layout.root.join("app/main.js")))
    );
    fs::remove_dir(scene.layout.root.join("app/main.js")).unwrap();
    fs::remove_dir_all(scene.layout.root.join("runtime")).unwrap();
    symlink(&scene.base, scene.layout.root.join("runtime")).unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Conflict(scene.layout.root.join("runtime")))
    );
}

#[test]
fn a_release_tree_not_exactly_as_its_manifest_lists_is_refused_before_any_change() {
    let cases: Vec<(&str, Change)> = vec![
        (
            "an extra file",
            Box::new(|root: &Path| fs::write(root.join("extra"), "x").unwrap()),
        ),
        (
            "a missing file",
            Box::new(|root: &Path| fs::remove_file(root.join("app/main.js")).unwrap()),
        ),
        (
            "a changed file",
            Box::new(|root: &Path| fs::write(root.join("app/main.js"), "main 0.1.X").unwrap()),
        ),
        (
            "a link",
            Box::new(|root: &Path| symlink("/bin/sh", root.join("app/link")).unwrap()),
        ),
        (
            "another mode",
            Box::new(|root: &Path| {
                fs::set_permissions(root.join("app/main.js"), fs::Permissions::from_mode(0o755))
                    .unwrap()
            }),
        ),
    ];
    for (case, change) in cases {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[]);
        change(&source);
        assert!(
            matches!(
                install(&scene.layout, &source, &expected, true, &never),
                Err(Problem::Source(_))
            ),
            "{case}"
        );
        assert!(!scene.layout.maintenance.exists(), "{case}");
    }
    // A manifest other than the one the installer was built for.
    let scene = scene();
    let (source, _) = release(&scene, "image", "0.1.0", &[]);
    assert!(matches!(
        install(&scene.layout, &source, &"0".repeat(64), true, &never),
        Err(Problem::Source(_))
    ));
}

/// Holds the gate as a running CLI does: a shared lock on its own open file.
fn hold_like_the_cli(scene: &Scene) -> fs::File {
    let gate = fs::File::open(scene.layout.maintenance.join("gate.lock")).unwrap();
    // SAFETY: the file is open; the lock is shared and does not wait.
    assert_eq!(
        unsafe { libc::flock(gate.as_raw_fd(), libc::LOCK_SH | libc::LOCK_NB) },
        0
    );
    gate
}

#[test]
fn a_running_cli_makes_an_apply_fail_at_once_but_not_a_preview() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
    let cli = hold_like_the_cli(&scene);
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Busy)
    );
    assert_eq!(uninstall(&scene.layout, true, &never), Err(Problem::Busy));
    assert!(install(&scene.layout, &source, &expected, false, &never).is_ok());
    assert!(uninstall(&scene.layout, false, &never).is_ok());
    assert_eq!(
        fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
        before
    );
    drop(cli);
}

#[test]
fn a_state_record_maintenance_did_not_write_stops_it() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    fs::write(
        scene.layout.maintenance.join("state.json"),
        br#"{"product":"urx-cli","format":1,"phase":"complete"}"#,
    )
    .unwrap();
    let unusable = Err(Problem::Maintenance(scene.layout.maintenance.clone()));
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        unusable
    );
    assert_eq!(uninstall(&scene.layout, true, &never), unusable);
}

#[test]
fn a_removal_removes_what_the_installation_owns_and_keeps_the_rest_and_the_gate() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let preview = uninstall(&scene.layout, false, &never).unwrap();
    assert!(
        preview.lines[0].starts_with("Would remove urx-cli 0.1.0"),
        "{:?}",
        preview.lines
    );
    assert!(launcher_accepts(&scene));
    fs::write(scene.layout.root.join("notices/user-note"), "mine").unwrap();
    let report = uninstall(&scene.layout, true, &never).unwrap();
    assert!(
        report
            .lines
            .iter()
            .any(|line| line.starts_with("Kept ") && line.contains("urx-cli:")),
        "{:?}",
        report.lines
    );
    assert!(fs::symlink_metadata(&scene.layout.link).is_err());
    assert_eq!(
        walk(&scene.layout.root),
        vec!["notices/user-note".to_owned()]
    );
    assert!(state_of(&scene).is_none());
    assert_eq!(
        fs::metadata(scene.layout.maintenance.join("gate.lock"))
            .unwrap()
            .len(),
        0
    );
    // A second run finds nothing of its own to remove and keeps the user's files.
    assert_eq!(
        uninstall(&scene.layout, true, &never),
        Err(Problem::Unrecorded(scene.layout.root.clone()))
    );
    fs::remove_dir_all(&scene.layout.root).unwrap();
    let again = uninstall(&scene.layout, true, &never).unwrap();
    assert_eq!(
        again.lines,
        vec!["urx-cli is not installed; nothing was removed.".to_owned()]
    );
}

#[test]
fn a_removal_keeps_a_link_that_no_longer_points_to_the_installation() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    fs::remove_file(&scene.layout.link).unwrap();
    symlink("/bin/sh", &scene.layout.link).unwrap();
    let report = uninstall(&scene.layout, true, &never).unwrap();
    assert!(report
        .lines
        .iter()
        .any(|line| line.starts_with(&format!("Kept {}", scene.layout.link.display()))));
    assert_eq!(
        fs::read_link(&scene.layout.link).unwrap(),
        Path::new("/bin/sh")
    );
    assert!(!scene.layout.root.exists());
}

#[test]
fn a_removal_interrupted_at_any_point_stays_removing_and_a_rerun_finishes_it() {
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &[]);
    install(&probe.layout, &source, &expected, true, &never).unwrap();
    let total = questions(&|stop| uninstall(&probe.layout, true, stop).map(|_| ()));
    assert!(total > 3, "{total}");
    for at in 1..=total {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[]);
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        let asked = Cell::new(0);
        let stop = || {
            asked.set(asked.get() + 1);
            asked.get() >= at
        };
        assert_eq!(
            uninstall(&scene.layout, true, &stop),
            Err(Problem::Interrupted),
            "at {at}"
        );
        let state = state_of(&scene).unwrap();
        if at > 1 {
            assert_eq!(state.phase, Phase::Removing, "at {at}");
            assert!(!launcher_accepts(&scene), "at {at}");
        }
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(state_of(&scene).is_none(), "at {at}");
        assert!(!scene.layout.root.exists(), "at {at}");
    }
}

#[test]
fn an_interrupted_removal_is_finished_by_the_same_release_installer_too() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let asked = Cell::new(0);
    let stop = || {
        asked.set(asked.get() + 1);
        asked.get() >= 4
    };
    assert_eq!(
        uninstall(&scene.layout, true, &stop),
        Err(Problem::Interrupted)
    );
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    assert!(launcher_accepts(&scene));
}
