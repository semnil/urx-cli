//! Installation, update and repair under K41: one process, under the
//! exclusive gate, admits and inspects, records `installing`, copies the
//! release's files, removes those only the previous release had, makes the
//! command link, verifies everything and makes it durable, and only then
//! records `complete`. A failure or an interruption before that leaves the
//! `installing` record, which keeps the CLI from starting until the same
//! release is installed again.

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{Phase, State, MANIFEST};
use crate::source::{self, Source};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, WalkError};
use crate::{Problem, Report};
use std::io::Write;
use std::path::Path;

/// What an apply would do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    /// Nothing is installed.
    Install,
    /// A complete installation of another release is replaced.
    Update { from: String },
    /// The same release is installed again: a complete one checked and
    /// rewritten, or an interrupted installation or removal finished.
    Repair,
}

struct Inspection {
    action: Action,
    /// Every path the installation may own now.
    previous: Vec<String>,
    link: LinkState,
}

/// Installs from the release tree at `source_path`, whose manifest must have
/// the SHA-256 `expected`. Without `apply` it only reports what an apply
/// would do, and changes nothing. `stop` is asked before each change; once
/// it answers true, nothing more is changed.
pub fn install(
    layout: &Layout,
    source_path: &Path,
    expected: &str,
    apply: bool,
    stop: &dyn Fn() -> bool,
) -> Result<Report, Problem> {
    let source = source::verify(source_path, expected)?;
    let held = place::hold(
        layout,
        if apply {
            Access::Write { create: true }
        } else {
            Access::Read
        },
    )?;
    let state = match &held {
        Some(held) => held.state(layout.owner)?,
        None => None,
    };
    let inspection = inspect(layout, &source, state.as_ref())?;
    let release = &source.manifest.release;
    if !apply {
        let mut report = Report::default();
        report.line(match &inspection.action {
            Action::Install => format!(
                "Would install urx-cli {release} into {}.",
                layout.root.display()
            ),
            Action::Update { from } => format!(
                "Would update urx-cli {from} to {release} in {}.",
                layout.root.display()
            ),
            Action::Repair => format!(
                "Would install urx-cli {release} again into {}.",
                layout.root.display()
            ),
        });
        if inspection.link == LinkState::Missing {
            report.line(format!(
                "Would link {} to {}.",
                layout.link.display(),
                layout.link_target().display()
            ));
        }
        report
            .line("Nothing was changed. Run it again with sudo and --apply to install.".to_owned());
        return Ok(report);
    }
    let held = held.expect("an apply holds the gate");
    let target = source.manifest.owned();
    let digest = source.digest();
    if stop() {
        return Err(Problem::Interrupted);
    }
    // Record before writing (K41 step 2): every path that may be owned.
    let mut owned = inspection.previous.clone();
    owned.extend(target.iter().cloned());
    owned.sort_unstable();
    owned.dedup();
    held.write_state(&State {
        phase: Phase::Installing,
        release: release.clone(),
        manifest: digest.clone(),
        owned,
    })?;
    let root = place::open_root(layout, true)?.expect("a created root is open");
    // Copy (step 3).
    for path in &target {
        if stop() {
            return Err(Problem::Interrupted);
        }
        put(layout, &root, &source, path)?;
    }
    for path in inspection
        .previous
        .iter()
        .filter(|path| target.binary_search(path).is_err())
    {
        if stop() {
            return Err(Problem::Interrupted);
        }
        crate::remove::remove_owned(layout, &root, path)?;
        crate::remove::prune(layout, &root, path)?;
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    place::make_link(layout)?;
    // Verify and make durable (step 4).
    for path in &target {
        check(layout, &root, &source, path)?;
    }
    if place::link_state(layout)? != LinkState::Owned {
        return Err(Problem::Verify(layout.link.clone()));
    }
    flush_folders(layout, &root)?;
    sys::sync(root.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
    let complete = State {
        phase: Phase::Complete,
        release: release.clone(),
        manifest: digest,
        owned: target,
    };
    // The record must be one the launcher starts from.
    if urx_launcher::install::check(&complete.to_bytes(), &source.manifest_bytes).is_err() {
        return Err(Problem::Verify(layout.maintenance.clone()));
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    held.write_state(&complete)?;
    let mut report = Report::default();
    report.line(match &inspection.action {
        Action::Install => format!(
            "Installed urx-cli {release} into {}.",
            layout.root.display()
        ),
        Action::Update { from } => format!(
            "Updated urx-cli {from} to {release} in {}.",
            layout.root.display()
        ),
        Action::Repair => format!(
            "Installed urx-cli {release} again into {}.",
            layout.root.display()
        ),
    });
    report.line(format!(
        "Run {} (or urx, where /usr/local/bin is on PATH).",
        layout.link.display()
    ));
    Ok(report)
}

/// The preflight (K41 step 1): what is installed, whether this release may
/// replace it, and that nothing foreign is where the installation goes.
fn inspect(layout: &Layout, source: &Source, state: Option<&State>) -> Result<Inspection, Problem> {
    let root = place::open_root(layout, false)?;
    let link = place::link_state(layout)?;
    if link == LinkState::Foreign {
        return Err(Problem::Conflict(layout.link.clone()));
    }
    let digest = source.digest();
    let (action, previous) = match state {
        None => {
            if root.is_some() {
                return Err(Problem::Unrecorded(layout.root.clone()));
            }
            (Action::Install, Vec::new())
        }
        Some(state) => {
            let same = state.manifest == digest;
            let action = match state.phase {
                Phase::Complete if same => Action::Repair,
                Phase::Complete => Action::Update {
                    from: state.release.clone(),
                },
                Phase::Installing | Phase::Removing if same => Action::Repair,
                Phase::Installing | Phase::Removing => {
                    return Err(Problem::Unfinished {
                        release: state.release.clone(),
                    })
                }
            };
            (action, state.owned.clone())
        }
    };
    if let Some(root) = &root {
        for path in source.manifest.owned() {
            match tree::parent_of(root, &path, Some(layout.owner), false) {
                Ok(None) => {}
                Ok(Some((parent, name))) => {
                    let entry = sys::entry_at(&parent, &name)
                        .map_err(|_| Problem::Conflict(layout.root.join(&path)))?;
                    if entry.is_some_and(|entry| entry.kind == Kind::Folder) {
                        return Err(Problem::Conflict(layout.root.join(&path)));
                    }
                }
                Err(WalkError::Conflict(at)) => {
                    return Err(Problem::Conflict(layout.root.join(at)))
                }
                Err(WalkError::Io(_)) => return Err(Problem::Conflict(layout.root.join(&path))),
            }
        }
    }
    Ok(Inspection {
        action,
        previous,
        link,
    })
}

/// Writes the owned file `path` from the source: to a pending sibling,
/// hashed as it is copied, given its mode and flushed, then renamed into
/// place. A file that no longer matches the manifest stops the installation.
fn put(layout: &Layout, root: &Fd, source: &Source, path: &str) -> Result<(), Problem> {
    let at = layout.root.join(path);
    let (parent, name) = match tree::parent_of(root, path, Some(layout.owner), true) {
        Ok(found) => found.expect("missing folders are made"),
        Err(WalkError::Conflict(conflict)) => {
            return Err(Problem::Conflict(layout.root.join(conflict)))
        }
        Err(WalkError::Io(_)) => return Err(Problem::Write(at)),
    };
    let failed = |_| Problem::Write(at.clone());
    let pending = place::pending(&name);
    sys::remove_at(&parent, &pending, false).map_err(failed)?;
    let mut file = sys::create_file_at(&parent, &pending).map_err(failed)?;
    if path == MANIFEST {
        file.write_all(&source.manifest_bytes).map_err(failed)?;
    } else {
        let expected = source
            .manifest
            .files
            .iter()
            .find(|file| file.path == path)
            .expect("an owned path other than the manifest is listed");
        let (from_parent, from_name) = tree::parent_of(&source.root, path, None, false)
            .ok()
            .flatten()
            .ok_or_else(|| changed(source, path))?;
        let (mut from, _) =
            sys::open_file_at(&from_parent, &from_name).map_err(|_| changed(source, path))?;
        let (sha256, size) = copy(&mut from, &mut file).map_err(failed)?;
        if sha256 != expected.sha256 || size != expected.size {
            drop(file);
            let _ = sys::remove_at(&parent, &pending, false);
            return Err(changed(source, path));
        }
    }
    sys::set_mode(&file, source::mode_of(path)).map_err(failed)?;
    sys::flush(std::os::unix::io::AsRawFd::as_raw_fd(&file)).map_err(failed)?;
    drop(file);
    if sys::entry_at(&parent, &name)
        .map_err(failed)?
        .is_some_and(|entry| entry.kind == Kind::Folder)
    {
        let _ = sys::remove_at(&parent, &pending, false);
        return Err(Problem::Conflict(at));
    }
    sys::rename_at(&parent, &pending, &name).map_err(failed)
}

fn changed(source: &Source, path: &str) -> Problem {
    Problem::Source(format!(
        "{}: {path} changed while it was installed",
        source.path.display()
    ))
}

/// Copies what is left of `from` to `to`, returning its SHA-256 and size.
fn copy(from: &mut std::fs::File, to: &mut std::fs::File) -> std::io::Result<(String, u64)> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 20];
    let mut size = 0u64;
    loop {
        let read = from.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        to.write_all(&buffer[..read])?;
        size += read as u64;
    }
    Ok((
        hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect(),
        size,
    ))
}

/// Reads the installed file `path` back: the owner's regular file with its
/// mode, holding exactly what the release lists.
fn check(layout: &Layout, root: &Fd, source: &Source, path: &str) -> Result<(), Problem> {
    let at = layout.root.join(path);
    let unverified = || Problem::Verify(at.clone());
    let (parent, name) = tree::parent_of(root, path, Some(layout.owner), false)
        .ok()
        .flatten()
        .ok_or_else(unverified)?;
    let (mut file, entry) = sys::open_file_at(&parent, &name).map_err(|_| unverified())?;
    if entry.owner != layout.owner || entry.mode != source::mode_of(path) {
        return Err(unverified());
    }
    let (sha256, size) = tree::hash(&mut file).map_err(|_| unverified())?;
    let matches = if path == MANIFEST {
        sha256 == source.digest() && size == source.manifest_bytes.len() as u64
    } else {
        source
            .manifest
            .files
            .iter()
            .any(|file| file.path == path && file.sha256 == sha256 && file.size == size)
    };
    if matches {
        Ok(())
    } else {
        Err(unverified())
    }
}

/// Flushes every folder under the root, so that each name made or removed
/// in it is on the disk.
fn flush_folders(layout: &Layout, root: &Fd) -> Result<(), Problem> {
    fn walk(folder: &Fd) -> std::io::Result<()> {
        for name in sys::names(folder)? {
            if sys::entry_at(folder, &name)?.is_some_and(|entry| entry.kind == Kind::Folder) {
                walk(&sys::open_folder_at(folder, &name)?)?;
            }
        }
        sys::flush(folder.raw())
    }
    walk(root).map_err(|_| Problem::Write(layout.root.clone()))
}
