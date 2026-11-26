//! The launcher end to end on this platform: a temporary bundle and
//! maintenance directory, the real handoff to a stand-in runtime, and the
//! gate held by the runtime while it runs. `launch` replaces the process on
//! macOS, so it runs in a child: this test binary again, selecting `child`.

use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};
use urx_launcher::install::Bundle;
use urx_launcher::{launch, Installation, Started};

const CHILD: &str = "URX_LAUNCHER_TEST_CHILD";

/// The stand-in runtime `cargo test` builds as an example.
fn fake_runtime() -> PathBuf {
    let deps = std::env::current_exe()
        .unwrap()
        .parent()
        .unwrap()
        .to_path_buf();
    let name = if cfg!(windows) {
        "fake-runtime.exe"
    } else {
        "fake-runtime"
    };
    deps.parent().unwrap().join("examples").join(name)
}

/// A complete installation in a scratch directory.
fn installation(name: &str) -> (PathBuf, PathBuf) {
    let scratch = std::env::temp_dir().join(format!("urx-launcher-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&scratch);
    let root = scratch.join("bundle");
    let maintenance = scratch.join("maintenance");
    for dir in [
        root.join("bin"),
        root.join("runtime"),
        root.join("app"),
        maintenance.clone(),
    ] {
        fs::create_dir_all(dir).unwrap();
    }
    let runtime = Bundle { root: root.clone() }.runtime();
    fs::copy(fake_runtime(), &runtime).unwrap();
    fs::write(root.join("app").join("main.js"), b"").unwrap();
    let manifest = br#"{"files":[]}"#;
    fs::write(root.join("release-manifest.json"), manifest).unwrap();
    let digest: String = Sha256::digest(manifest)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let state = serde_json::json!({ "product": "urx-cli", "format": 1, "phase": "complete", "release": "0.1.0", "manifest": digest });
    fs::write(maintenance.join("state.json"), state.to_string()).unwrap();
    fs::write(maintenance.join("gate.lock"), b"").unwrap();
    (root, maintenance)
}

/// Runs `launch` in a child with `arguments`, `NODE_OPTIONS` and `KEPT` set.
fn launched(root: &Path, maintenance: &Path, arguments: &[&str]) -> std::process::Child {
    Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "child",
            "--nocapture",
            "--test-threads=1",
            "--quiet",
        ])
        .env(
            CHILD,
            format!(
                "{}\n{}\n{}",
                root.display(),
                maintenance.display(),
                arguments.join("\n")
            ),
        )
        .env("NODE_OPTIONS", "--require=/nonexistent")
        .env("node_path", "x")
        .env("KEPT", "yes")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap()
}

/// The child's side: starts the runtime through the real handoff.
#[test]
fn child() {
    let Ok(spec) = std::env::var(CHILD) else {
        return;
    };
    let mut lines = spec.lines();
    let root = PathBuf::from(lines.next().unwrap());
    let maintenance = PathBuf::from(lines.next().unwrap());
    let arguments: Vec<OsString> = lines.map(OsString::from).collect();
    let installation = Installation {
        maintenance,
        bundle: Bundle { root },
        owner: None,
    };
    match launch(&installation, arguments, std::env::vars_os().collect()) {
        Ok(Started::Exited(code)) => std::process::exit(code as i32),
        Err(failure) => {
            eprintln!("{}", failure.message());
            std::process::exit(1)
        }
    }
}

#[test]
fn the_runtime_gets_the_entry_and_the_arguments_unchanged_without_node_variables() {
    let (root, maintenance) = installation("arguments");
    let output = launched(
        &root,
        &maintenance,
        &[
            "channel",
            "fader",
            "set",
            "--value=-6",
            "two words",
            "",
            "名前",
            "exit=7",
        ],
    )
    .wait_with_output()
    .unwrap();
    assert_eq!(
        output.status.code(),
        Some(7),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    // The test harness writes its own lines before the handoff; the runtime's are prefixed.
    let lines: Vec<&str> = stdout
        .lines()
        .filter(|line| {
            ["arg:", "node:", "kept:"]
                .iter()
                .any(|prefix| line.starts_with(prefix))
        })
        .collect();
    let entry = format!("arg:{}", root.join("app").join("main.js").display());
    let expected_arguments = [
        "arg:channel",
        "arg:fader",
        "arg:set",
        "arg:--value=-6",
        "arg:two words",
        "arg:",
        "arg:名前",
        "arg:exit=7",
    ];
    assert_eq!(lines[0], entry);
    assert_eq!(&lines[1..=expected_arguments.len()], expected_arguments);
    // macOS removes the exact prefix only; Windows names are case-insensitive.
    let node: Vec<&&str> = lines
        .iter()
        .filter(|line| line.starts_with("node:"))
        .collect();
    if cfg!(windows) {
        assert!(node.is_empty(), "{node:?}");
    } else {
        assert_eq!(node, [&"node:node_path"]);
    }
    assert!(lines.contains(&"kept:yes"));
    fs::remove_dir_all(root.parent().unwrap()).unwrap();
}

#[test]
fn the_runtime_holds_the_gate_until_it_exits() {
    let (root, maintenance) = installation("gate");
    let mut child = launched(&root, &maintenance, &["sleep=1500"]);
    let gate = maintenance.join("gate.lock");
    let started = Instant::now();
    // While the runtime runs, an exclusive open of the gate is refused.
    let mut held = false;
    while started.elapsed() < Duration::from_millis(1200) {
        if exclusive_refused(&gate) {
            held = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(held, "the gate was not held while the runtime ran");
    assert_eq!(child.wait().unwrap().code(), Some(0));
    assert!(
        !exclusive_refused(&gate),
        "the gate stayed held after the runtime exited"
    );
    fs::remove_dir_all(root.parent().unwrap()).unwrap();
}

#[test]
fn an_incomplete_or_busy_installation_starts_nothing() {
    let (root, maintenance) = installation("incomplete");
    fs::write(
        maintenance.join("state.json"),
        br#"{"product":"urx-cli","format":1,"phase":"installing","manifest":""}"#,
    )
    .unwrap();
    let output = launched(&root, &maintenance, &["exit=7"])
        .wait_with_output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    // Nothing reached the runtime: none of its lines, only the harness's.
    assert!(!String::from_utf8_lossy(&output.stdout).contains("arg:"));
    assert!(String::from_utf8_lossy(&output.stderr).contains("incomplete or damaged"));
    fs::remove_dir_all(root.parent().unwrap()).unwrap();
}

#[cfg(unix)]
fn exclusive_refused(gate: &Path) -> bool {
    use std::os::unix::io::AsRawFd;
    let file = fs::File::open(gate).unwrap();
    // SAFETY: the descriptor is open for this call; the lock does not wait.
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 }
}

#[cfg(windows)]
fn exclusive_refused(gate: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    // Maintenance opens the gate with no sharing; a reader with read sharing refuses it.
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(gate)
        .is_err()
}
