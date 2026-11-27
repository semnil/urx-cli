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
/// The old release's files, the new release's, and the paths the new layout must have.
type LayoutChange = (
    &'static [(&'static str, &'static str)],
    &'static [(&'static str, &'static str)],
    &'static [&'static str],
);

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
        // The temporary folder above it may be the user's alone.
        top: base.clone(),
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

fn names_in(folder: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(folder)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

/// The files a release tree made by `release` holds, as installed.
fn files_of(scene: &Scene, name: &str) -> Vec<String> {
    walk(&scene.base.join(name).join("urx-cli"))
}

/// Nothing beside the root but the root: no work folder is left.
fn no_work_folder(scene: &Scene) -> bool {
    names_in(scene.layout.root.parent().unwrap())
        .iter()
        .all(|name| name == "urx-cli")
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
    for (path, wanted) in [
        ("bin/urx", 0o755),
        ("runtime/node", 0o755),
        ("maintenance/urx-uninstall", 0o755),
        ("notices/LICENSE", 0o644),
        (MANIFEST, 0o644),
        ("", 0o755),
        ("app", 0o755),
    ] {
        assert_eq!(mode(&root.join(path)), wanted, "{path}");
    }
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
    assert_eq!(walk(root), files_of(&scene, "image"));
    assert!(no_work_folder(&scene));
}

#[test]
fn the_same_release_repairs_a_changed_file() {
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
    assert!(no_work_folder(&scene));
}

#[test]
fn an_update_replaces_the_previous_tree_and_leaves_nothing_of_it() {
    let scene = scene();
    let (old, old_digest) = release(
        &scene,
        "old",
        "0.1.0",
        &[("notices/OLD", "old"), ("app/gone/x.js", "x")],
    );
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[("notices/NEW", "new")]);
    let report = install(&scene.layout, &new, &new_digest, true, &never).unwrap();
    assert!(
        report.lines[0].starts_with("Updated urx-cli 0.1.0 to 0.2.0"),
        "{:?}",
        report.lines
    );
    assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"));
    assert!(no_work_folder(&scene));
    let state = state_of(&scene).unwrap();
    assert!(!state.owned.contains(&"notices/OLD".to_owned()));
    assert!(launcher_accepts(&scene));
}

#[test]
fn something_someone_put_in_the_installation_stops_an_update_or_a_repair_and_a_removal_keeps_it() {
    for name in [
        "notices/user-note",
        "app/main.js.urx-pending",
        "Private/archive/notes",
    ] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let at = scene.layout.root.join(name);
        fs::create_dir_all(at.parent().unwrap()).unwrap();
        fs::write(&at, "user data").unwrap();
        fs::set_permissions(&at, fs::Permissions::from_mode(0o600)).unwrap();
        let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
        // The first entry that is not the installation's: a folder it does not own, or the file itself.
        let first_foreign = match name {
            "notices/user-note" => scene.layout.root.join("notices"),
            "Private/archive/notes" => scene.layout.root.join("Private"),
            _ => at.clone(),
        };
        for (source, digest) in [(&new, &new_digest), (&old, &old_digest)] {
            assert_eq!(
                install(&scene.layout, source, digest, false, &never),
                Err(Problem::Conflict(first_foreign.clone())),
                "{name}"
            );
            assert_eq!(
                install(&scene.layout, source, digest, true, &never),
                Err(Problem::Conflict(first_foreign.clone())),
                "{name}"
            );
        }
        assert_eq!(
            fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
            before,
            "{name}"
        );
        assert!(launcher_accepts(&scene), "{name}");
        uninstall(&scene.layout, true, &never).unwrap();
        assert_eq!(fs::read_to_string(&at).unwrap(), "user data", "{name}");
        assert_eq!(mode(&at), 0o600, "{name}");
    }
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

fn stop_at(at: usize) -> impl Fn() -> bool {
    let asked = Cell::new(0);
    move || {
        asked.set(asked.get() + 1);
        asked.get() >= at
    }
}

#[test]
fn an_installation_interrupted_at_any_point_leaves_no_partial_tree_and_is_finished_by_the_same_release(
) {
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
    let total =
        questions(&|stop| install(&probe.layout, &source, &expected, true, stop).map(|_| ()));
    assert!(total > 5, "{total}");
    for at in 1..=total {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(at)),
            Err(Problem::Interrupted),
            "at {at}"
        );
        assert!(!launcher_accepts(&scene), "at {at}");
        // The root is absent or the whole release, never part of it.
        if scene.layout.root.exists() {
            assert_eq!(
                walk(&scene.layout.root),
                files_of(&scene, "image"),
                "at {at}"
            );
        }
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        assert!(launcher_accepts(&scene), "at {at}");
        assert!(no_work_folder(&scene), "at {at}");
    }
}

#[test]
fn an_update_interrupted_at_any_point_leaves_one_tree_or_the_other_and_only_its_release_finishes_it(
) {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[("notices/OLD", "old")]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("notices/NEW", "new")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for at in 1..=total {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[("notices/OLD", "old")]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("notices/NEW", "new")]);
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(at)),
            Err(Problem::Interrupted),
            "at {at}"
        );
        let tree = walk(&scene.layout.root);
        assert!(
            tree == files_of(&scene, "old") || tree == files_of(&scene, "new"),
            "at {at}: {tree:?}"
        );
        if at > 1 {
            assert_eq!(
                install(&scene.layout, &old, &old_digest, true, &never),
                Err(Problem::Unfinished {
                    release: "0.2.0".to_owned()
                }),
                "at {at}"
            );
        }
        install(&scene.layout, &new, &new_digest, true, &never).unwrap();
        assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"), "at {at}");
        assert!(launcher_accepts(&scene), "at {at}");
        assert!(no_work_folder(&scene), "at {at}");
    }
}

#[test]
fn a_file_put_while_an_update_was_interrupted_stops_its_resumption_and_a_removal_keeps_it() {
    for resume in ["update", "removal"] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/notes", "release 2")]);
        // Stopped with the release assembled beside the root, before it is put in place.
        let total = questions(&|stop| {
            let probe = self::scene();
            let (o, od) = release(&probe, "old", "0.1.0", &[]);
            install(&probe.layout, &o, &od, true, &never).unwrap();
            let (n, nd) = release(&probe, "new", "0.2.0", &[("app/notes", "release 2")]);
            install(&probe.layout, &n, &nd, true, stop).map(|_| ())
        });
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(total - 3)),
            Err(Problem::Interrupted)
        );
        let notes = scene.layout.root.join("app/notes");
        assert!(!notes.exists(), "the root is still the previous tree");
        fs::write(&notes, "release 2").unwrap();
        if resume == "update" {
            assert_eq!(
                install(&scene.layout, &new, &new_digest, true, &never),
                Err(Problem::Conflict(notes.clone()))
            );
        } else {
            let report = uninstall(&scene.layout, true, &never).unwrap();
            assert!(
                report
                    .lines
                    .iter()
                    .any(|line| line.starts_with(&format!("Kept {}", scene.layout.root.display()))),
                "{:?}",
                report.lines
            );
            assert!(no_work_folder(&scene));
        }
        assert_eq!(fs::read_to_string(&notes).unwrap(), "release 2", "{resume}");
    }
}

#[test]
fn a_removal_after_an_interrupted_installation_removes_the_tree_at_the_root_and_the_work_folder() {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("z/added", "added")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for at in 2..=total {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("z/added", "added")]);
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(at)),
            Err(Problem::Interrupted),
            "at {at}"
        );
        // Interrupted again partway through the removal, then resumed.
        let removal = questions(&|stop| {
            let probe = self::scene();
            let (o, od) = release(&probe, "old", "0.1.0", &[]);
            install(&probe.layout, &o, &od, true, &never).unwrap();
            let (n, nd) = release(&probe, "new", "0.2.0", &[("z/added", "added")]);
            let _ = install(&probe.layout, &n, &nd, true, &stop_at(at));
            uninstall(&probe.layout, true, stop).map(|_| ())
        });
        let _ = uninstall(&scene.layout, true, &stop_at(removal / 2 + 1));
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(
            !scene.layout.root.exists(),
            "at {at}: {:?}",
            scene.layout.root.exists().then(|| walk(&scene.layout.root))
        );
        assert!(
            names_in(scene.layout.root.parent().unwrap()).is_empty(),
            "at {at}"
        );
        assert!(state_of(&scene).is_none(), "at {at}");
    }
}

#[test]
fn a_removal_that_cannot_read_the_installed_manifest_while_installing_changes_nothing() {
    let scene = scene();
    let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
    assert_eq!(
        install(&scene.layout, &new, &new_digest, true, &stop_at(2)),
        Err(Problem::Interrupted)
    );
    let manifest = scene.layout.root.join(MANIFEST);
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o000)).unwrap();
    let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
    assert_eq!(
        uninstall(&scene.layout, true, &never),
        Err(Problem::Write(manifest.clone()))
    );
    assert_eq!(
        fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
        before
    );
    fs::set_permissions(&manifest, fs::Permissions::from_mode(0o644)).unwrap();
    uninstall(&scene.layout, true, &never).unwrap();
    assert!(!scene.layout.root.exists());
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
    // A folder where an owned file is, and a link where an owned folder is.
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
    // A work folder of this release's name holding something the installation did not make.
    let scene = self::scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    let staging = scene
        .layout
        .root
        .with_file_name(format!("urx-cli.install-{}", &expected[..16]));
    fs::create_dir_all(&staging).unwrap();
    fs::write(staging.join("mine"), "user data").unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Conflict(staging.join("mine")))
    );
    assert_eq!(
        fs::read_to_string(staging.join("mine")).unwrap(),
        "user data"
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
fn a_running_cli_makes_an_apply_fail_at_once_with_no_mode_changed_but_not_a_preview() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
    fs::set_permissions(&scene.layout.maintenance, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(
        scene.layout.maintenance.join("gate.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
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
    assert_eq!(mode(&scene.layout.maintenance), 0o700);
    assert_eq!(mode(&scene.layout.maintenance.join("gate.lock")), 0o600);
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
fn a_removal_interrupted_at_any_point_is_finished_by_a_rerun_or_the_same_release_installer() {
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &[]);
    install(&probe.layout, &source, &expected, true, &never).unwrap();
    let total = questions(&|stop| uninstall(&probe.layout, true, stop).map(|_| ()));
    assert!(total > 3, "{total}");
    for finish in ["removal", "installer"] {
        for at in 1..=total {
            let scene = scene();
            let (source, expected) = release(&scene, "image", "0.1.0", &[]);
            install(&scene.layout, &source, &expected, true, &never).unwrap();
            let stopped = uninstall(&scene.layout, true, &stop_at(at));
            assert!(
                matches!(
                    stopped,
                    Err(Problem::Interrupted)
                        | Err(Problem::RemovalUnfinished { interrupted: true })
                ),
                "at {at}: {stopped:?}"
            );
            if at > 1 {
                assert_eq!(state_of(&scene).unwrap().phase, Phase::Removing, "at {at}");
                assert!(!launcher_accepts(&scene), "at {at}");
            }
            if finish == "removal" {
                uninstall(&scene.layout, true, &never).unwrap();
                assert!(state_of(&scene).is_none(), "at {at}");
                assert!(!scene.layout.root.exists(), "at {at}");
            } else {
                install(&scene.layout, &source, &expected, true, &never).unwrap();
                assert!(launcher_accepts(&scene), "at {at}");
                assert_eq!(
                    walk(&scene.layout.root),
                    files_of(&scene, "image"),
                    "at {at}"
                );
            }
        }
    }
}

#[test]
fn the_installed_removal_tool_goes_after_every_other_file_but_the_manifest() {
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
    install(&probe.layout, &source, &expected, true, &never).unwrap();
    let total = questions(&|stop| uninstall(&probe.layout, true, stop).map(|_| ()));
    for at in 1..=total {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("notices/LICENSE", "MIT")]);
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        let result = uninstall(&scene.layout, true, &stop_at(at));
        let tool = scene.layout.root.join("maintenance/urx-uninstall");
        let left: Vec<String> = if scene.layout.root.exists() {
            walk(&scene.layout.root)
        } else {
            Vec::new()
        };
        let others_left = left
            .iter()
            .any(|path| path != "maintenance/urx-uninstall" && path != MANIFEST);
        if others_left {
            assert!(
                tool.exists(),
                "at {at}: another file is left without the removal tool"
            );
            assert_eq!(result, Err(Problem::Interrupted), "at {at}");
        } else if !tool.exists() {
            assert_eq!(
                result,
                Err(Problem::RemovalUnfinished { interrupted: true }),
                "at {at}"
            );
            assert_eq!(result.unwrap_err().exit_code(), 130);
        }
        // The manifest goes last of the files.
        if !scene.layout.root.join(MANIFEST).exists() {
            assert!(left.is_empty(), "at {at}: {left:?}");
        }
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(state_of(&scene).is_none(), "at {at}");
    }
}

#[test]
fn a_removal_that_fails_once_the_removal_tool_is_gone_names_the_other_copy() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let parent = scene.layout.root.parent().unwrap().to_path_buf();
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o555)).unwrap();
    let result = uninstall(&scene.layout, true, &never);
    fs::set_permissions(&parent, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(
        result,
        Err(Problem::RemovalUnfinished { interrupted: false })
    );
    assert_eq!(result.unwrap_err().exit_code(), 1);
    uninstall(&scene.layout, true, &never).unwrap();
    assert!(state_of(&scene).is_none());
}

#[test]
fn an_update_that_reshapes_the_layout_ends_with_the_new_layout_alone() {
    let changes: [LayoutChange; 6] = [
        (
            &[("app/readme", "old")],
            &[("app/README", "new")],
            &["app/README"],
        ),
        (
            &[("app/module/x.js", "old")],
            &[("app/Module/x.js", "new")],
            &["app/Module/x.js"],
        ),
        (
            &[("app/part", "old")],
            &[("app/part/index.js", "new")],
            &["app/part/index.js"],
        ),
        (
            &[("app/part/index.js", "old")],
            &[("app/part", "new")],
            &["app/part"],
        ),
        (
            &[("app/module/part", "old")],
            &[("app/Module/part/index.js", "new")],
            &["app/Module/part/index.js"],
        ),
        (
            &[("app/Module/part/index.js", "old")],
            &[("app/module/part", "new")],
            &["app/module/part"],
        ),
    ];
    for (old_files, new_files, expected) in changes {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", old_files);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", new_files);
        install(&scene.layout, &new, &new_digest, true, &never).unwrap();
        assert!(launcher_accepts(&scene), "{new_files:?}");
        assert_eq!(
            walk(&scene.layout.root),
            files_of(&scene, "new"),
            "{new_files:?}"
        );
        for path in expected {
            assert_eq!(
                fs::read_to_string(scene.layout.root.join(path)).unwrap(),
                "new",
                "{path}"
            );
            let mut folder = scene.layout.root.clone();
            for name in path.split('/') {
                assert!(
                    names_in(&folder).contains(&name.to_owned()),
                    "{name} in {}: {:?}",
                    folder.display(),
                    names_in(&folder)
                );
                folder.push(name);
            }
        }
        install(&scene.layout, &new, &new_digest, true, &never).unwrap();
        assert!(launcher_accepts(&scene), "{new_files:?}");
        assert!(no_work_folder(&scene), "{new_files:?}");
    }
}

#[test]
fn a_folder_of_the_installation_s_given_a_mode_it_does_not_make_stops_an_update_before_any_change()
{
    let scene = scene();
    let (old, old_digest) = release(
        &scene,
        "old",
        "0.1.0",
        &[("app/module/part/sub/index.js", "old")],
    );
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    // Someone gave a folder of the installation's a mode it does not make.
    fs::set_permissions(
        scene.layout.root.join("app/module/part/sub"),
        fs::Permissions::from_mode(0o775),
    )
    .unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/module/part", "new")]);
    assert_eq!(
        install(&scene.layout, &new, &new_digest, true, &never),
        Err(Problem::Conflict(
            scene.layout.root.join("app/module/part/sub")
        ))
    );
    assert!(launcher_accepts(&scene));
}

#[test]
fn an_apply_gives_the_installation_the_modes_every_user_needs() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    for folder in [
        scene.layout.root.clone(),
        scene.layout.root.join("app"),
        scene.layout.maintenance.clone(),
    ] {
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fs::set_permissions(
        scene.layout.maintenance.join("gate.lock"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    for folder in [
        scene.layout.root.clone(),
        scene.layout.root.join("app"),
        scene.layout.maintenance.clone(),
    ] {
        assert_eq!(mode(&folder), 0o755, "{}", folder.display());
    }
    assert_eq!(mode(&scene.layout.maintenance.join("gate.lock")), 0o644);
    let usr = scene.base.join("usr");
    fs::set_permissions(&usr, fs::Permissions::from_mode(0o700)).unwrap();
    let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Unreachable(fs::canonicalize(&usr).unwrap()))
    );
    assert_eq!(
        fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
        before
    );
    fs::set_permissions(&usr, fs::Permissions::from_mode(0o755)).unwrap();
}

#[test]
fn a_folder_other_users_cannot_pass_behind_a_link_stops_the_installation() {
    for place in ["lib", "bin", "Library"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[]);
        let hidden = scene.base.join("hidden");
        fs::create_dir_all(hidden.join("inner")).unwrap();
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0o700)).unwrap();
        let parent = match place {
            "lib" => scene.layout.root.parent().unwrap().to_path_buf(),
            "bin" => scene.layout.link.parent().unwrap().to_path_buf(),
            _ => scene.layout.maintenance.parent().unwrap().to_path_buf(),
        };
        fs::create_dir_all(parent.parent().unwrap()).unwrap();
        let _ = fs::remove_dir_all(&parent);
        symlink(hidden.join("inner"), &parent).unwrap();
        let result = install(&scene.layout, &source, &expected, true, &never);
        assert_eq!(
            result,
            Err(Problem::Unreachable(fs::canonicalize(&hidden).unwrap())),
            "{place}"
        );
        assert!(state_of(&scene).is_none(), "{place}");
        fs::set_permissions(&hidden, fs::Permissions::from_mode(0o755)).unwrap();
    }
}

#[test]
fn a_parent_others_can_change_stops_the_installation_before_any_change() {
    for (folder, mode_given) in [
        ("usr/local/lib", 0o777),
        ("usr/local/lib", 0o775),
        ("Library", 0o757),
    ] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[]);
        let at = scene.base.join(folder);
        fs::create_dir_all(&at).unwrap();
        fs::set_permissions(&at, fs::Permissions::from_mode(mode_given)).unwrap();
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &never),
            Err(Problem::Exposed(fs::canonicalize(&at).unwrap())),
            "{folder} {mode_given:o}"
        );
        assert!(!scene.layout.maintenance.exists(), "{folder}");
        assert!(!scene.layout.root.exists(), "{folder}");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        assert!(launcher_accepts(&scene), "{folder}");
    }
}
