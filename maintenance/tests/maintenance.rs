//! Installation, update, repair and removal in folders of the test's own,
//! with the test's user as the owner the fixed layout gives root.
#![cfg(unix)]

use std::cell::Cell;
use std::fs;
use std::os::unix::fs::{symlink, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use urx_maintenance::install::install;
use urx_maintenance::mark::MARK;
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

/// Gives `path` the installer's mark holding `value`, or takes it away (None), as someone could.
fn set_mark(path: &Path, value: Option<&str>) {
    let path = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();
    let name = std::ffi::CString::new(MARK).unwrap();
    // SAFETY: both names are NUL-terminated and the value is readable for its length.
    let done = unsafe {
        match value {
            Some(value) => libc::setxattr(
                path.as_ptr(),
                name.as_ptr(),
                value.as_ptr().cast(),
                value.len(),
                0,
                libc::XATTR_NOFOLLOW,
            ),
            None => libc::removexattr(path.as_ptr(), name.as_ptr(), libc::XATTR_NOFOLLOW),
        }
    };
    assert_eq!(done, 0, "{}", std::io::Error::last_os_error());
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
fn a_removal_that_cannot_enter_a_folder_of_the_installation_s_stops_and_keeps_its_record() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("app/plugins/x.js", "x")]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    for folder in ["app", "app/plugins", "maintenance"] {
        let at = scene.layout.root.join(folder);
        fs::set_permissions(&at, fs::Permissions::from_mode(0o775)).unwrap();
        let result = uninstall(&scene.layout, true, &never);
        assert!(
            matches!(result, Err(Problem::Conflict(ref path)) if path == &at),
            "{folder}: {result:?}"
        );
        assert_eq!(state_of(&scene).unwrap().phase, Phase::Removing, "{folder}");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    }
    uninstall(&scene.layout, true, &never).unwrap();
    assert!(!scene.layout.root.exists());
    assert!(state_of(&scene).is_none());
}

#[test]
fn a_removal_stopped_right_after_it_records_removing_finishes_in_both_places_whatever_finishes_it()
{
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[("app/old.js", "old")]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("app/new.js", "new")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for update in [false, true] {
        for at in 2..=total {
            for finish in ["removal", "installer"] {
                let scene = scene();
                let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/new.js", "new")]);
                if update {
                    let (old, old_digest) =
                        release(&scene, "old", "0.1.0", &[("app/old.js", "old")]);
                    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
                }
                let _ = install(&scene.layout, &new, &new_digest, true, &stop_at(at));
                // The root's manifest lost too: the record alone tells what is where.
                let _ = fs::remove_file(scene.layout.root.join(MANIFEST));
                let _ = uninstall(&scene.layout, true, &stop_at(2));
                if finish == "removal" {
                    uninstall(&scene.layout, true, &never).unwrap();
                    assert!(
                        names_in(scene.layout.root.parent().unwrap()).is_empty(),
                        "at {at}"
                    );
                    assert!(state_of(&scene).is_none(), "at {at}");
                } else {
                    install(&scene.layout, &new, &new_digest, true, &never).unwrap();
                    assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"), "at {at}");
                    assert!(no_work_folder(&scene), "at {at}");
                }
            }
        }
    }
}

#[test]
fn a_repair_interrupted_after_its_swap_still_gives_the_folders_their_modes() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("app/plugins/x.js", "x")]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    let total = questions(&|stop| {
        let probe = self::scene();
        let (s, e) = release(&probe, "image", "0.1.0", &[("app/plugins/x.js", "x")]);
        install(&probe.layout, &s, &e, true, &never).unwrap();
        install(&probe.layout, &s, &e, true, stop).map(|_| ())
    });
    // Stopped right after the swap, then a folder's mode changed.
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &stop_at(total - 2)),
        Err(Problem::Interrupted)
    );
    for folder in ["", "app", "runtime", "app/plugins"] {
        fs::set_permissions(
            scene.layout.root.join(folder),
            fs::Permissions::from_mode(0o700),
        )
        .unwrap();
    }
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    for folder in ["", "app", "runtime", "app/plugins"] {
        assert_eq!(mode(&scene.layout.root.join(folder)), 0o755, "{folder}");
    }
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
    // It is left as it is, and the release is assembled under another name.
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    assert!(launcher_accepts(&scene));
    assert_eq!(names_in(&staging), vec!["mine".to_owned()]);
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
    // Run as anyone but root, reachability is not judged, and the preview says so.
    let preview = install(&scene.layout, &source, &expected, false, &never).unwrap();
    assert!(
        preview
            .lines
            .iter()
            .any(|line| line.contains("checked when this runs with sudo")),
        "{:?}",
        preview.lines
    );
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

#[test]
fn a_removal_stops_too_while_others_can_change_a_parent_and_keeps_everything() {
    for folder in ["usr/local/lib", "Library", "usr"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[]);
        install(&scene.layout, &source, &expected, true, &never).unwrap();
        let at = scene.base.join(folder);
        fs::set_permissions(&at, fs::Permissions::from_mode(0o775)).unwrap();
        let before = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
        let exposed = Err(Problem::Exposed(fs::canonicalize(&at).unwrap()));
        assert_eq!(uninstall(&scene.layout, false, &never), exposed, "{folder}");
        assert_eq!(uninstall(&scene.layout, true, &never), exposed, "{folder}");
        assert_eq!(
            fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
            before,
            "{folder}"
        );
        assert_eq!(
            walk(&scene.layout.root),
            files_of(&scene, "image"),
            "{folder}"
        );
        fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(!scene.layout.root.exists(), "{folder}");
    }
}

fn work_folder(scene: &Scene, digest: &str) -> PathBuf {
    scene
        .layout
        .root
        .with_file_name(format!("urx-cli.install-{}", &digest[..16]))
}

#[test]
fn a_work_folder_made_but_not_recorded_is_left_and_the_release_is_assembled_under_another_name() {
    for update in [false, true] {
        let scene = scene();
        if update {
            let (old, old_digest) = release(&scene, "old", "0.1.0", &[("app/old.js", "old")]);
            install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        }
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/new.js", "new")]);
        // Stopped just before the work folder is made; then a folder appears at its name, as
        // when the record of the one made could not be written.
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(2)),
            Err(Problem::Interrupted)
        );
        let unrecorded = work_folder(&scene, &new_digest);
        fs::create_dir(&unrecorded).unwrap();
        install(&scene.layout, &new, &new_digest, true, &never).unwrap();
        assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"));
        assert!(
            unrecorded.exists(),
            "the folder no record names is left as it is"
        );
        assert!(launcher_accepts(&scene));
        // A removal leaves it too.
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(unrecorded.exists());
        assert!(state_of(&scene).is_none());
    }
}

#[test]
fn after_a_swap_with_no_later_record_each_tree_is_told_by_its_object() {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[("app/old.js", "old")]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("app/new.js", "new")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for finish in ["removal", "installer"] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[("app/old.js", "old")]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/new.js", "new")]);
        // Stopped right after the swap: the new tree at the root, the previous one beside it.
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(total - 2)),
            Err(Problem::Interrupted)
        );
        assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"));
        assert_eq!(
            walk(&work_folder(&scene, &new_digest)),
            files_of(&scene, "old")
        );
        // A user's file where only the previous release had one.
        let mine = scene.layout.root.join("app/old.js");
        fs::write(&mine, "user data").unwrap();
        if finish == "removal" {
            uninstall(&scene.layout, true, &never).unwrap();
            assert_eq!(fs::read_to_string(&mine).unwrap(), "user data");
            assert_eq!(walk(&scene.layout.root), vec!["app/old.js".to_owned()]);
            assert!(!work_folder(&scene, &new_digest).exists());
        } else {
            // The user's file in the root keeps the installer from it.
            assert_eq!(
                install(&scene.layout, &new, &new_digest, true, &never),
                Err(Problem::Conflict(mine.clone()))
            );
            fs::remove_file(&mine).unwrap();
            install(&scene.layout, &new, &new_digest, true, &never).unwrap();
            assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"));
            assert!(no_work_folder(&scene));
        }
    }
}

#[test]
fn in_an_interrupted_work_folder_only_what_the_run_made_is_removed_whatever_it_holds() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let files = [("app/new.js", "new"), ("app/plugins/x.js", "x")];
        let (source, expected) = release(&scene, "image", "0.1.0", &files);
        // Stopped with the manifest and app/main.js written, app/new.js and app/plugins not yet.
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        assert!(work.join("app/main.js").exists() && !work.join("app/new.js").exists());
        // Someone's: a file holding exactly what the release lists, an empty folder at a folder
        // of the release, and a folder of their own.
        fs::write(work.join("app/new.js"), "new").unwrap();
        fs::set_permissions(work.join("app/new.js"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::create_dir(work.join("app/plugins")).unwrap();
        fs::set_permissions(work.join("app/plugins"), fs::Permissions::from_mode(0o700)).unwrap();
        fs::create_dir(work.join("mine")).unwrap();
        // The run's: a file cut short, and one at a reserved name not yet marked.
        fs::OpenOptions::new()
            .write(true)
            .open(work.join("app/main.js"))
            .unwrap()
            .set_len(2)
            .unwrap();
        fs::write(work.join("app/.urx-new-99"), "part").unwrap();
        let report = if finish == "installer" {
            let report = install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert_eq!(walk(&scene.layout.root), files_of(&scene, "image"));
            assert!(launcher_accepts(&scene));
            report
        } else {
            let report = uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
            report
        };
        assert!(
            report.lines.iter().any(|line| line
                == &format!(
                    "Kept {}: it holds files the installation did not make (app/new.js, app/plugins, mine).",
                    work.display()
                )),
            "{finish}: {:?}",
            report.lines
        );
        assert_eq!(walk(&work), vec!["app/new.js".to_owned()], "{finish}");
        assert_eq!(
            fs::read_to_string(work.join("app/new.js")).unwrap(),
            "new",
            "{finish}"
        );
        assert_eq!(mode(&work.join("app/new.js")), 0o600, "{finish}");
        assert!(names_in(&work.join("app/plugins")).is_empty(), "{finish}");
        assert!(work.join("mine").is_dir(), "{finish}");
        assert_eq!(
            names_in(&work),
            vec!["app".to_owned(), "mine".to_owned()],
            "{finish}"
        );
    }
}

#[test]
fn a_folder_in_the_work_folder_the_removal_cannot_enter_stops_it_with_its_record() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("app/plugins/x.js", "x")]);
    let total = questions(&|stop| {
        let probe = self::scene();
        let (s, e) = release(&probe, "image", "0.1.0", &[("app/plugins/x.js", "x")]);
        install(&probe.layout, &s, &e, true, stop).map(|_| ())
    });
    // Stopped with the release assembled, before it is put in place.
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &stop_at(total - 2)),
        Err(Problem::Interrupted)
    );
    let work = work_folder(&scene, &expected);
    for folder in ["app", "app/plugins", "maintenance"] {
        let at = work.join(folder);
        fs::set_permissions(&at, fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(
            uninstall(&scene.layout, true, &never),
            Err(Problem::Conflict(at.clone())),
            "{folder}"
        );
        assert_eq!(state_of(&scene).unwrap().phase, Phase::Removing, "{folder}");
        // The release manifest goes last.
        assert!(work.join(MANIFEST).is_file(), "{folder}");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
    }
    uninstall(&scene.layout, true, &never).unwrap();
    assert!(!work.exists());
    assert!(state_of(&scene).is_none());
}

/// A stop that never stops and, at question `at`, does `act`.
fn act_at<'a>(at: usize, act: impl Fn() + 'a) -> impl Fn() -> bool + 'a {
    let asked = Cell::new(0);
    move || {
        asked.set(asked.get() + 1);
        if asked.get() == at {
            act();
        }
        false
    }
}

#[test]
fn a_name_another_folder_takes_just_before_the_release_is_put_in_place_stops_it_and_is_kept() {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[("app/old.js", "old")]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("app/new.js", "new")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for replaced in ["root", "work folder"] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[("app/old.js", "old")]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/new.js", "new")]);
        let at = if replaced == "root" {
            scene.layout.root.clone()
        } else {
            work_folder(&scene, &new_digest)
        };
        let moved = scene.layout.root.with_file_name("moved");
        // The last question before the swap: a folder of someone else's takes the name.
        let take = || {
            fs::rename(&at, &moved).unwrap();
            fs::create_dir(&at).unwrap();
            fs::write(at.join("mine"), "user data").unwrap();
        };
        assert_eq!(
            install(
                &scene.layout,
                &new,
                &new_digest,
                true,
                &act_at(total - 3, take)
            ),
            Err(Problem::Conflict(at.clone())),
            "{replaced}"
        );
        assert_eq!(names_in(&at), vec!["mine".to_owned()], "{replaced}");
        assert_eq!(
            fs::read_to_string(at.join("mine")).unwrap(),
            "user data",
            "{replaced}"
        );
        assert_eq!(
            state_of(&scene).unwrap().phase,
            Phase::Installing,
            "{replaced}"
        );
    }
}

#[test]
fn a_folder_that_takes_the_recorded_work_folder_s_name_is_left_as_it_is() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        // Stopped with the work folder made and recorded, nothing written in it yet.
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(3)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        assert_eq!(
            state_of(&scene).unwrap().work.map(|work| work.name),
            Some(work.file_name().unwrap().to_string_lossy().into_owned())
        );
        // Another folder at its name: made before the recorded one goes, so it is another object.
        let moved = scene.layout.root.with_file_name("moved");
        fs::rename(&work, &moved).unwrap();
        fs::create_dir(&work).unwrap();
        fs::remove_dir_all(&moved).unwrap();
        let report = if finish == "installer" {
            let report = install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert_eq!(walk(&scene.layout.root), files_of(&scene, "image"));
            assert!(launcher_accepts(&scene));
            report
        } else {
            let report = uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
            report
        };
        assert!(work.is_dir() && names_in(&work).is_empty(), "{finish}");
        assert!(
            !report
                .lines
                .iter()
                .any(|line| line.starts_with(&format!("Kept {}:", work.display()))),
            "{finish}: {:?}",
            report.lines
        );
    }
}

#[test]
fn what_carries_no_mark_of_its_work_folder_is_kept_and_the_run_finishes() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        // Stopped with the manifest and app/main.js written.
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        // The run's app/main.js with its mark taken away, and someone's file with another work
        // folder's mark.
        set_mark(&work.join("app/main.js"), None);
        fs::write(work.join("app/copied.js"), "copied").unwrap();
        set_mark(&work.join("app/copied.js"), Some("1"));
        if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert!(launcher_accepts(&scene));
        } else {
            uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
        }
        assert_eq!(
            walk(&work),
            vec!["app/copied.js".to_owned(), "app/main.js".to_owned()],
            "{finish}"
        );
    }
}

#[test]
fn a_file_put_in_place_of_one_the_run_made_is_kept() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &stop_at(4)),
        Err(Problem::Interrupted)
    );
    let work = work_folder(&scene, &expected);
    // Another file at the manifest's path, holding exactly the manifest: another object.
    let manifest = fs::read(work.join(MANIFEST)).unwrap();
    fs::remove_file(work.join(MANIFEST)).unwrap();
    fs::write(work.join(MANIFEST), &manifest).unwrap();
    uninstall(&scene.layout, true, &never).unwrap();
    assert_eq!(walk(&work), vec![MANIFEST.to_owned()]);
    assert!(state_of(&scene).is_none());
}

#[test]
fn a_resumed_installation_assembles_under_a_name_other_than_the_interrupted_run_s() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &stop_at(5)),
        Err(Problem::Interrupted)
    );
    let first = work_folder(&scene, &expected);
    assert!(first.join(MANIFEST).is_file());
    // Resumed and stopped at its first write: the interrupted folder, holding nothing but the
    // release's files, is gone, and the release is assembled under the next name.
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &stop_at(3)),
        Err(Problem::Interrupted)
    );
    assert!(!first.exists());
    let second = format!("{}-2", first.file_name().unwrap().to_string_lossy());
    assert_eq!(
        state_of(&scene).unwrap().work.map(|work| work.name),
        Some(second.clone())
    );
    assert!(first.with_file_name(&second).is_dir());
    // The next run goes back to the first name, free again.
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    assert!(no_work_folder(&scene));
    assert_eq!(walk(&scene.layout.root), files_of(&scene, "image"));
    assert!(launcher_accepts(&scene));
}

#[test]
fn a_folder_put_at_the_root_s_name_while_a_removal_is_interrupted_stops_both_tools_and_is_kept() {
    let scene = scene();
    let (source, expected) = release(&scene, "image", "0.1.0", &[]);
    install(&scene.layout, &source, &expected, true, &never).unwrap();
    // Stopped right after recording `removing`.
    assert_eq!(
        uninstall(&scene.layout, true, &stop_at(2)),
        Err(Problem::Interrupted)
    );
    assert_eq!(state_of(&scene).unwrap().phase, Phase::Removing);
    let root = &scene.layout.root;
    let moved = root.with_file_name("moved");
    fs::rename(root, &moved).unwrap();
    fs::create_dir_all(root.join("app")).unwrap();
    fs::write(root.join("app/main.js"), "local restore").unwrap();
    assert_eq!(
        uninstall(&scene.layout, true, &never),
        Err(Problem::Conflict(root.clone()))
    );
    assert_eq!(
        install(&scene.layout, &source, &expected, true, &never),
        Err(Problem::Conflict(root.clone()))
    );
    assert_eq!(
        fs::read_to_string(root.join("app/main.js")).unwrap(),
        "local restore"
    );
    assert_eq!(state_of(&scene).unwrap().phase, Phase::Removing);
    // The recorded tree back: the removal finishes.
    fs::remove_dir_all(root).unwrap();
    fs::rename(&moved, root).unwrap();
    uninstall(&scene.layout, true, &never).unwrap();
    assert!(state_of(&scene).is_none());
    assert!(!root.exists());
}

#[test]
fn a_folder_put_at_the_root_s_name_of_a_complete_installation_stops_both_tools_and_is_kept() {
    let scene = scene();
    let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
    install(&scene.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
    let root = &scene.layout.root;
    let moved = root.with_file_name("moved");
    fs::rename(root, &moved).unwrap();
    fs::create_dir_all(root.join("app")).unwrap();
    fs::write(root.join("app/main.js"), "local restore").unwrap();
    for (source, digest) in [(&new, &new_digest), (&old, &old_digest)] {
        for apply in [false, true] {
            assert_eq!(
                install(&scene.layout, source, digest, apply, &never),
                Err(Problem::Conflict(root.clone()))
            );
        }
    }
    for apply in [false, true] {
        assert_eq!(
            uninstall(&scene.layout, apply, &never),
            Err(Problem::Conflict(root.clone()))
        );
    }
    assert_eq!(
        fs::read_to_string(root.join("app/main.js")).unwrap(),
        "local restore"
    );
    assert_eq!(state_of(&scene).unwrap().phase, Phase::Complete);
    fs::remove_dir_all(root).unwrap();
    fs::rename(&moved, root).unwrap();
    install(&scene.layout, &new, &new_digest, true, &never).unwrap();
    assert_eq!(walk(root), files_of(&scene, "new"));
}

#[test]
fn a_recorded_work_folder_no_longer_as_made_stops_both_tools_with_its_record() {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[("app/old.js", "old")]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[("app/new.js", "new")]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    // Before the swap the work folder holds the release; after it, the previous tree.
    for (at, finish) in [
        (total - 3, "removal"),
        (total - 3, "installer"),
        (total - 2, "removal"),
        (total - 2, "installer"),
    ] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[("app/old.js", "old")]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[("app/new.js", "new")]);
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(at)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &new_digest);
        let held = walk(&work);
        let record = fs::read(scene.layout.maintenance.join("state.json")).unwrap();
        fs::set_permissions(&work, fs::Permissions::from_mode(0o775)).unwrap();
        let stopped = if finish == "removal" {
            uninstall(&scene.layout, true, &never)
        } else {
            install(&scene.layout, &new, &new_digest, true, &never).map(|_| Default::default())
        };
        assert_eq!(
            stopped,
            Err(Problem::Conflict(work.clone())),
            "{at} {finish}"
        );
        // Stopped before the record changed.
        assert_eq!(
            fs::read(scene.layout.maintenance.join("state.json")).unwrap(),
            record,
            "{at} {finish}"
        );
        assert_eq!(walk(&work), held, "{at} {finish}");
        fs::set_permissions(&work, fs::Permissions::from_mode(0o755)).unwrap();
        if finish == "removal" {
            uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none(), "{at} {finish}");
        } else {
            install(&scene.layout, &new, &new_digest, true, &never).unwrap();
            assert_eq!(
                walk(&scene.layout.root),
                files_of(&scene, "new"),
                "{at} {finish}"
            );
        }
        assert!(no_work_folder(&scene), "{at} {finish}");
    }
}

#[test]
fn something_put_in_the_work_folder_while_it_is_assembled_stops_the_installation_and_is_kept() {
    // Before app/main.js is written, a folder at `app`; before app/new.js, a file there.
    for (at, path) in [(4, "app"), (5, "app/new.js")] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        let work = work_folder(&scene, &expected);
        let put = || {
            let there = work.join(path);
            if path == "app" {
                fs::create_dir(&there).unwrap();
            } else {
                fs::write(&there, "new").unwrap();
            }
        };
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &act_at(at, put)),
            Err(Problem::Conflict(work.join(path))),
            "{path}"
        );
        // Neither tool takes it for the installation's.
        let report = uninstall(&scene.layout, true, &never).unwrap();
        assert!(work.join(path).exists(), "{path}");
        assert!(
            report
                .lines
                .iter()
                .any(|line| line.starts_with(&format!("Kept {}:", work.display()))),
            "{path}: {:?}",
            report.lines
        );
        assert!(state_of(&scene).is_none(), "{path}");
    }
}

#[test]
fn a_work_folder_kept_with_someone_s_files_does_not_stop_the_next_run() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        fs::write(work.join("app/new.js"), "new").unwrap();
        // Stopped right after the work folder was cleared.
        let stopped = if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &stop_at(2)).map(|_| ())
        } else {
            uninstall(&scene.layout, true, &stop_at(3)).map(|_| ())
        };
        // With nothing installed at the root, the removal names the other copy to finish with.
        let interrupted = if finish == "installer" {
            Problem::Interrupted
        } else {
            Problem::RemovalUnfinished { interrupted: true }
        };
        assert_eq!(stopped, Err(interrupted), "{finish}");
        assert_eq!(walk(&work), vec!["app/new.js".to_owned()], "{finish}");
        // The next run does not stop at the file left there.
        if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert!(launcher_accepts(&scene));
        } else {
            uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
        }
        assert_eq!(walk(&work), vec!["app/new.js".to_owned()], "{finish}");
    }
}

#[test]
fn a_folder_the_removal_cannot_enter_in_the_previous_tree_beside_the_root_stops_it_with_the_manifest_kept(
) {
    let probe = scene();
    let (old, old_digest) = release(&probe, "old", "0.1.0", &[]);
    install(&probe.layout, &old, &old_digest, true, &never).unwrap();
    let (new, new_digest) = release(&probe, "new", "0.2.0", &[]);
    let total =
        questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
    for folder in ["app", "maintenance", "native"] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
        // Stopped right after the swap: the previous tree at the work folder's name.
        assert_eq!(
            install(&scene.layout, &new, &new_digest, true, &stop_at(total - 2)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &new_digest);
        assert_eq!(walk(&work), files_of(&scene, "old"));
        let at = work.join(folder);
        fs::set_permissions(&at, fs::Permissions::from_mode(0o775)).unwrap();
        assert_eq!(
            uninstall(&scene.layout, true, &never),
            Err(Problem::Conflict(at.clone())),
            "{folder}"
        );
        assert!(work.join(MANIFEST).is_file(), "{folder}");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o755)).unwrap();
        uninstall(&scene.layout, true, &never).unwrap();
        assert!(no_work_folder(&scene), "{folder}");
        assert!(state_of(&scene).is_none(), "{folder}");
    }
}

#[test]
fn something_put_in_the_work_folder_before_it_goes_in_place_stops_it_with_the_previous_tree_kept() {
    for (from, extra) in [
        (None, ".DS_Store"),
        (Some("0.1.0"), "app/local-note"),
        (Some("0.2.0"), "app/empty-dir"),
    ] {
        let probe = scene();
        if let Some(version) = from {
            let (old, digest) = release(&probe, "old", version, &[]);
            install(&probe.layout, &old, &digest, true, &never).unwrap();
        }
        let (new, new_digest) = release(&probe, "new", "0.2.0", &[]);
        let total =
            questions(&|stop| install(&probe.layout, &new, &new_digest, true, stop).map(|_| ()));
        let scene = scene();
        if let Some(version) = from {
            let (old, digest) = release(&scene, "old", version, &[]);
            install(&scene.layout, &old, &digest, true, &never).unwrap();
        }
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
        let before = scene.layout.root.exists().then(|| walk(&scene.layout.root));
        let work = work_folder(&scene, &new_digest);
        // At the last question before the release is checked and put in place.
        let last_put = if from.is_some() { total - 4 } else { total - 3 };
        let put = || {
            if extra.ends_with("-dir") {
                fs::create_dir(work.join(extra)).unwrap();
            } else {
                fs::write(work.join(extra), "someone's").unwrap();
            }
        };
        assert_eq!(
            install(
                &scene.layout,
                &new,
                &new_digest,
                true,
                &act_at(last_put, put)
            ),
            Err(Problem::Conflict(work.join(extra))),
            "{extra}"
        );
        assert_eq!(
            scene.layout.root.exists().then(|| walk(&scene.layout.root)),
            before,
            "{extra}"
        );
        assert!(work.join(extra).exists(), "{extra}");
        // The next run assembles anew under another name, and keeps it.
        install(&scene.layout, &new, &new_digest, true, &never).unwrap();
        assert_eq!(walk(&scene.layout.root), files_of(&scene, "new"), "{extra}");
        assert!(work.join(extra).exists(), "{extra}");
    }
}

#[test]
fn a_reserved_name_someone_puts_in_a_complete_installation_is_theirs() {
    for name in [".urx-journal", ".urx-new-1", "app/.urx-new-2"] {
        let scene = scene();
        let (old, old_digest) = release(&scene, "old", "0.1.0", &[]);
        install(&scene.layout, &old, &old_digest, true, &never).unwrap();
        let (new, new_digest) = release(&scene, "new", "0.2.0", &[]);
        let at = scene.layout.root.join(name);
        fs::write(&at, "someone's").unwrap();
        fs::set_permissions(&at, fs::Permissions::from_mode(0o600)).unwrap();
        for (source, digest) in [(&new, &new_digest), (&old, &old_digest)] {
            for apply in [false, true] {
                assert_eq!(
                    install(&scene.layout, source, digest, apply, &never),
                    Err(Problem::Conflict(at.clone())),
                    "{name}"
                );
            }
        }
        uninstall(&scene.layout, true, &never).unwrap();
        assert_eq!(fs::read_to_string(&at).unwrap(), "someone's", "{name}");
        assert_eq!(mode(&at), 0o600, "{name}");
        assert!(state_of(&scene).is_none(), "{name}");
    }
}

#[test]
fn an_entry_whose_mark_cannot_be_read_stops_both_tools_with_its_record() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        let at = work.join("app/main.js");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o000)).unwrap();
        let stopped = if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).map(|_| ())
        } else {
            uninstall(&scene.layout, true, &never).map(|_| ())
        };
        assert_eq!(stopped, Err(Problem::Conflict(at.clone())), "{finish}");
        assert!(state_of(&scene).is_some(), "{finish}");
        fs::set_permissions(&at, fs::Permissions::from_mode(0o644)).unwrap();
        if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert!(launcher_accepts(&scene));
        } else {
            uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
        }
        assert!(no_work_folder(&scene), "{finish}");
    }
}

fn run(command: &str, args: &[&Path]) {
    let status = std::process::Command::new(command)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "{command} {args:?}");
}

#[test]
fn a_copy_that_took_the_mark_with_it_is_kept_and_the_original_goes_under_any_name() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        // Stopped with the manifest and app/main.js written.
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        // Copies made in the work folder with their extended attributes, then changed; the
        // original renamed.
        run(
            "cp",
            &[&work.join("app/main.js"), &work.join("app/main-copy.js")],
        );
        run(
            "cp",
            &[Path::new("-R"), &work.join("app"), &work.join("app-copy")],
        );
        fs::write(work.join("app/main-copy.js"), "edited").unwrap();
        fs::write(work.join("app-copy/main.js"), "edited").unwrap();
        fs::rename(work.join("app/main.js"), work.join("app/renamed.js")).unwrap();
        let report = if finish == "installer" {
            let report = install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert!(launcher_accepts(&scene));
            report
        } else {
            let report = uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
            report
        };
        assert_eq!(
            walk(&work),
            vec![
                "app-copy/main-copy.js".to_owned(),
                "app-copy/main.js".to_owned(),
                "app/main-copy.js".to_owned(),
            ],
            "{finish}"
        );
        assert!(report.lines.iter().any(|line| line
            == &format!(
                "Kept {}: it holds files the installation did not make (app-copy/main-copy.js, app-copy/main.js, app/main-copy.js).",
                work.display()
            )), "{finish}: {:?}", report.lines);
    }
}

#[test]
fn the_run_s_files_under_a_folder_without_its_mark_are_still_cleared() {
    let files = [("app/plugins/x.js", "x"), ("app/plugins/y.js", "y")];
    let probe = scene();
    let (source, expected) = release(&probe, "image", "0.1.0", &files);
    let total =
        questions(&|stop| install(&probe.layout, &source, &expected, true, stop).map(|_| ()));
    for (change, finish) in [
        ("app", "installer"),
        ("app", "removal"),
        ("app/plugins", "installer"),
        ("app/plugins", "removal"),
        ("remade", "installer"),
        ("remade", "removal"),
    ] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &files);
        // Stopped with the release written, before it is put in place.
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(total - 2)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        let plugins = work.join("app/plugins");
        fs::write(plugins.join("note"), "someone's").unwrap();
        if change == "remade" {
            // Another folder in its place, the run's files moved into it.
            let moved = work.join("app/moved");
            fs::rename(&plugins, &moved).unwrap();
            fs::create_dir(&plugins).unwrap();
            for name in names_in(&moved) {
                fs::rename(moved.join(&name), plugins.join(&name)).unwrap();
            }
            fs::remove_dir(&moved).unwrap();
        } else {
            set_mark(&work.join(change), None);
        }
        if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).unwrap();
            assert!(launcher_accepts(&scene));
        } else {
            uninstall(&scene.layout, true, &never).unwrap();
            assert!(state_of(&scene).is_none());
        }
        assert_eq!(
            walk(&work),
            vec!["app/plugins/note".to_owned()],
            "{change} {finish}"
        );
    }
}

#[test]
fn a_folder_in_the_work_folder_that_cannot_be_looked_into_safely_stops_both_tools() {
    for finish in ["installer", "removal"] {
        let scene = scene();
        let (source, expected) = release(&scene, "image", "0.1.0", &[("app/new.js", "new")]);
        assert_eq!(
            install(&scene.layout, &source, &expected, true, &stop_at(5)),
            Err(Problem::Interrupted)
        );
        let work = work_folder(&scene, &expected);
        let mine = work.join("mine");
        fs::create_dir(&mine).unwrap();
        fs::set_permissions(&mine, fs::Permissions::from_mode(0o777)).unwrap();
        let stopped = if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).map(|_| ())
        } else {
            uninstall(&scene.layout, true, &never).map(|_| ())
        };
        assert_eq!(stopped, Err(Problem::Conflict(mine.clone())), "{finish}");
        assert!(state_of(&scene).is_some(), "{finish}");
        fs::set_permissions(&mine, fs::Permissions::from_mode(0o755)).unwrap();
        if finish == "installer" {
            install(&scene.layout, &source, &expected, true, &never).unwrap();
        } else {
            uninstall(&scene.layout, true, &never).unwrap();
        }
        assert_eq!(names_in(&work), vec!["mine".to_owned()], "{finish}");
    }
}
