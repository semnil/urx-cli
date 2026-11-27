//! Installation, update and repair under K41 as revised (assembled beside
//! the root): one process, under the exclusive gate, admits and inspects,
//! records `installing`, assembles the complete release in a work folder
//! beside the root, verifies it, and puts it in place with one rename (a swap
//! with the previous tree, or a rename where no root is). It then removes the
//! previous tree, left at the work folder's name, by its recorded paths,
//! makes the command link, verifies everything and makes it durable, and
//! only then records `complete`. An interruption therefore leaves at the root
//! either the previous tree or the complete release, never a partly written
//! tree; the `installing` record keeps the CLI from starting until the same
//! release is installed again.

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{pending_tag, Phase, State, Work, MANIFEST};
use crate::source::{self, Source};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::{Problem, Report};
use std::collections::BTreeSet;
use std::ffi::CString;
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
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

/// What is at the root.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Root {
    Absent,
    /// The installation's recorded files of the complete installation the
    /// run starts from (all or some of them), and nothing else.
    Previous,
    /// Exactly this release, put in place by a run interrupted after the swap.
    Target,
}

struct Inspection {
    action: Action,
    /// The files of the tree to replace: none, the tree at the root, or after
    /// an interrupted swap the previous tree, then in the work folder.
    base: Vec<String>,
    root: Root,
    /// Which object the root is, when there is one.
    root_id: Option<(u64, u64)>,
    /// The work folder an interrupted run recorded.
    work: Option<Work>,
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
    place::check_not_exposed(layout)?;
    place::check_reachable(layout, false)?;
    // The root's parent, opened once: every name below is acted on through this descriptor.
    let parent_now = place::root_parent(layout, false)?;
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
    let inspection = inspect(layout, parent_now.as_ref(), &source, state.as_ref())?;
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
        if !place::judges_reachability(layout) {
            report.line(
                "Whether every user can reach it is checked when this runs with sudo.".to_owned(),
            );
        }
        report
            .line("Nothing was changed. Run it again with sudo and --apply to install.".to_owned());
        return Ok(report);
    }
    let held = held.expect("an apply holds the gate");
    let target = source.manifest.owned();
    let digest = source.digest();
    let tag = pending_tag(&digest).to_owned();
    if stop() {
        return Err(Problem::Interrupted);
    }
    // Record before writing (K41 step 2): this release's files, the tree's at the root, which
    // of the two the root holds, and the work folder an interrupted run recorded.
    let record = |placed: bool, work: Option<Work>| State {
        phase: Phase::Installing,
        release: release.clone(),
        manifest: digest.clone(),
        owned: target.clone(),
        base: Some(inspection.base.clone()),
        placed: Some(placed),
        work,
    };
    held.write_state(&record(
        inspection.root == Root::Target,
        inspection.work.clone(),
    ))?;
    let parent = match parent_now {
        Some(parent) => parent,
        None => place::root_parent(layout, true)?.expect("a made parent is open"),
    };
    let staging_path = place::staging(layout, &tag);
    let staging_name = c_last(&staging_path);
    let root_name = c_last(&layout.root);
    let mut report = Report::default();
    // The work folder to clear after the swap: the previous tree, under its recorded identity.
    let mut previous_work = inspection.work.clone();
    let mut placed_id: Option<(u64, u64)> = None;
    if inspection.root != Root::Target {
        // A work folder an interrupted run recorded goes first; any other there stopped the preflight.
        if !clear_work(
            layout,
            &parent,
            &staging_name,
            &staging_path,
            inspection.work.as_ref(),
        )? {
            return Err(Problem::Conflict(staging_path));
        }
        if stop() {
            return Err(Problem::Interrupted);
        }
        let failed = |_| Problem::Write(staging_path.clone());
        // Root's alone while it is assembled.
        let staging = sys::make_folder_at(&parent, &staging_name, 0o700).map_err(failed)?;
        let staging_id = sys::entry(staging.raw()).map_err(failed)?.id;
        held.write_state(&record(
            false,
            Some(Work {
                id: staging_id,
                files: target.clone(),
            }),
        ))?;
        // Assemble (step 3), every file in a folder of this run's own.
        for path in &target {
            if stop() {
                return Err(Problem::Interrupted);
            }
            put(layout, &staging, &staging_path, &source, path)?;
        }
        settle_folders(&staging, &staging_path, &target)?;
        for path in &target {
            check(layout, &staging, &staging_path, &source, path)?;
        }
        sys::flush(staging.raw()).map_err(failed)?;
        drop(staging);
        if stop() {
            return Err(Problem::Interrupted);
        }
        // The names are still the objects checked: the work folder made here, and the root
        // inspected (or nothing there).
        let at_name = |name: &std::ffi::CStr| {
            sys::entry_at(&parent, name)
                .ok()
                .flatten()
                .map(|entry| entry.id)
        };
        if at_name(&staging_name) != Some(staging_id) {
            return Err(Problem::Conflict(staging_path));
        }
        if at_name(&root_name) != inspection.root_id {
            return Err(Problem::Conflict(layout.root.clone()));
        }
        // Put in place with one rename: the previous tree goes to the work folder's name.
        let placed = if inspection.root == Root::Absent {
            sys::rename_exclusive(&parent, &staging_name, &root_name)
        } else {
            sys::swap(&parent, &staging_name, &root_name)
        };
        placed.map_err(|_| Problem::Write(layout.root.clone()))?;
        sys::sync(parent.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
        placed_id = Some(staging_id);
        previous_work = inspection.root_id.map(|id| Work {
            id,
            files: inspection.base.clone(),
        });
        held.write_state(&record(true, previous_work.clone()))?;
    }
    // The previous tree, now at the work folder's name, under its recorded identity.
    if stop() {
        return Err(Problem::Interrupted);
    }
    if !clear_work(
        layout,
        &parent,
        &staging_name,
        &staging_path,
        previous_work.as_ref(),
    )? {
        report.line(format!(
            "Kept {}: the previous installation left files there that it did not make.",
            staging_path.display()
        ));
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    place::make_link(layout)?;
    // Verify and make durable (step 4).
    let root = place::open_ours(&parent, &root_name, &layout.root, layout.owner)?
        .ok_or_else(|| Problem::Verify(layout.root.clone()))?;
    if placed_id.is_some_and(|id| sys::entry(root.raw()).ok().map(|entry| entry.id) != Some(id)) {
        return Err(Problem::Verify(layout.root.clone()));
    }
    let target_set: BTreeSet<String> = target.iter().cloned().collect();
    if !is_release(layout, &root, &source, &target_set) {
        return Err(Problem::Verify(layout.root.clone()));
    }
    if place::link_state(layout)? != LinkState::Owned {
        return Err(Problem::Verify(layout.link.clone()));
    }
    place::check_reachable(layout, true)?;
    sys::sync(root.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
    let complete = State {
        phase: Phase::Complete,
        release: release.clone(),
        manifest: digest,
        owned: target,
        base: None,
        placed: None,
        work: None,
    };
    // The record must be one the launcher starts from.
    if urx_launcher::install::check(&complete.to_bytes(), &source.manifest_bytes).is_err() {
        return Err(Problem::Verify(layout.maintenance.clone()));
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    held.write_state(&complete)?;
    report.lines.insert(
        0,
        match &inspection.action {
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
        },
    );
    report.line(format!(
        "Run {} (or urx, where /usr/local/bin is on PATH).",
        layout.link.display()
    ));
    Ok(report)
}

fn c_last(path: &Path) -> CString {
    CString::new(
        path.file_name()
            .map(|name| name.as_bytes())
            .unwrap_or_default(),
    )
    .unwrap_or_default()
}

/// The preflight (K41 step 1): what is installed, whether this release may
/// replace it, and that the root and the work folder are the installation's
/// recorded ones, holding nothing but their recorded files. Anything else
/// there stops it here, before the record changes, and is kept (K18).
fn inspect(
    layout: &Layout,
    parent: Option<&Fd>,
    source: &Source,
    state: Option<&State>,
) -> Result<Inspection, Problem> {
    let root = match parent {
        Some(parent) => {
            place::open_ours(parent, &c_last(&layout.root), &layout.root, layout.owner)?
        }
        None => None,
    };
    let link = place::link_state(layout)?;
    if link == LinkState::Foreign {
        return Err(Problem::Conflict(layout.link.clone()));
    }
    let digest = source.digest();
    let action = match state {
        None if root.is_some() => return Err(Problem::Unrecorded(layout.root.clone())),
        None => Action::Install,
        Some(state) => {
            let same = state.manifest == digest;
            match state.phase {
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
            }
        }
    };
    let work = state.and_then(|state| state.work.clone());
    let conflict = |at: &Path, error: std::io::Result<Result<(), String>>| match error {
        Ok(Ok(())) => Ok(()),
        Ok(Err(entry)) => Err(Problem::Conflict(at.join(entry))),
        Err(_) => Err(Problem::Conflict(at.to_path_buf())),
    };
    // Only the work folder a run recorded is the installation's, and it holds only its recorded files.
    if let Some(parent) = parent {
        let staging_path = place::staging(layout, pending_tag(&digest));
        if let Some(staging) =
            place::open_ours(parent, &c_last(&staging_path), &staging_path, layout.owner)?
        {
            let id = sys::entry(staging.raw())
                .map_err(|_| Problem::Conflict(staging_path.clone()))?
                .id;
            let Some(recorded) = work.as_ref().filter(|work| work.id == id) else {
                return Err(Problem::Conflict(staging_path));
            };
            let files: BTreeSet<String> = recorded.files.iter().cloned().collect();
            conflict(
                &staging_path,
                tree::only_listed(&staging, "", &files, layout.owner),
            )?;
        }
    }
    let target: BTreeSet<String> = source.manifest.owned().into_iter().collect();
    let recorded_root: Vec<String> = state
        .map(|state| state.root_files().to_vec())
        .unwrap_or_default();
    let placed =
        state.is_some_and(|state| state.phase == Phase::Installing && state.placed == Some(true));
    let (root_state, base) = match &root {
        None => (Root::Absent, Vec::new()),
        // The release put in place by an interrupted run, folders' modes included.
        Some(root) if placed && is_release(layout, root, source, &target) => (
            Root::Target,
            state
                .and_then(|state| state.base.clone())
                .unwrap_or_default(),
        ),
        Some(root) => {
            let files: BTreeSet<String> = recorded_root.iter().cloned().collect();
            conflict(
                &layout.root,
                tree::only_listed(root, "", &files, layout.owner),
            )?;
            (Root::Previous, recorded_root)
        }
    };
    let root_id = match &root {
        Some(root) => Some(
            sys::entry(root.raw())
                .map_err(|_| Problem::Conflict(layout.root.clone()))?
                .id,
        ),
        None => None,
    };
    Ok(Inspection {
        action,
        base,
        root: root_state,
        root_id,
        work,
        link,
    })
}

/// Whether the open root holds exactly this release: each of its files as
/// listed, the root and each folder of its files 0755, and nothing else.
fn is_release(layout: &Layout, root: &Fd, source: &Source, target: &BTreeSet<String>) -> bool {
    let folders_made = || {
        let folders: BTreeSet<&str> = target
            .iter()
            .flat_map(|path| path.match_indices('/').map(move |(end, _)| &path[..end]))
            .collect();
        sys::entry(root.raw()).is_ok_and(|entry| entry.mode == 0o755)
            && folders.iter().all(|folder| {
                matches!(tree::parent_of(root, folder, Some(layout.owner), How::Exact), Ok(Some((parent, name)))
                    if matches!(sys::entry_at(&parent, &name), Ok(Some(entry)) if entry.kind == Kind::Folder && entry.mode == 0o755))
            })
    };
    matches!(
        tree::only_listed(root, "", target, layout.owner),
        Ok(Ok(()))
    ) && folders_made()
        && target
            .iter()
            .all(|path| check(layout, root, &layout.root, source, path).is_ok())
}

/// Removes the work folder `name` in `parent` when it is the one `work`
/// records: each of its recorded files, each folder of the installation's
/// left empty, then the folder itself. True when it is gone or was never
/// there; false when it is another object, or something else keeps it: then
/// it stays.
fn clear_work(
    layout: &Layout,
    parent: &Fd,
    name: &std::ffi::CStr,
    path: &Path,
    work: Option<&Work>,
) -> Result<bool, Problem> {
    let Some(staging) = place::open_ours(parent, name, path, layout.owner)? else {
        return Ok(true);
    };
    let failed = |_| Problem::Write(path.to_path_buf());
    let Some(work) =
        work.filter(|work| sys::entry(staging.raw()).is_ok_and(|entry| entry.id == work.id))
    else {
        return Ok(false);
    };
    let files: BTreeSet<String> = work.files.iter().cloned().collect();
    if !tree::clear_listed(&staging, "", &files, layout.owner).map_err(failed)? {
        return Ok(false);
    }
    drop(staging);
    match sys::remove_at(parent, name, true) {
        Ok(_) => {
            sys::flush(parent.raw()).map_err(failed)?;
            Ok(true)
        }
        Err(error)
            if matches!(
                error.raw_os_error(),
                Some(libc::ENOTEMPTY) | Some(libc::EEXIST)
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(failed(error)),
    }
}

/// Writes the owned file `path` from the source into the work folder
/// `staging` (at `at`), made by this run: hashed as it is copied, given its
/// mode and flushed. A file that no longer matches the manifest stops the
/// installation.
fn put(
    layout: &Layout,
    staging: &Fd,
    at: &Path,
    source: &Source,
    path: &str,
) -> Result<(), Problem> {
    let written = at.join(path);
    let (parent, name) = match tree::parent_of(staging, path, Some(layout.owner), How::Make) {
        Ok(found) => found.expect("missing folders are made"),
        Err(WalkError::Conflict(conflict)) => return Err(Problem::Conflict(at.join(conflict))),
        Err(WalkError::Io(_)) => return Err(Problem::Write(written)),
    };
    let failed = |_| Problem::Write(written.clone());
    let mut file = sys::create_file_at(&parent, &name).map_err(failed)?;
    if path == MANIFEST {
        file.write_all(&source.manifest_bytes).map_err(failed)?;
    } else {
        let expected = source
            .manifest
            .files
            .iter()
            .find(|file| file.path == path)
            .expect("an owned path other than the manifest is listed");
        let (from_parent, from_name) = tree::parent_of(&source.root, path, None, How::Lookup)
            .ok()
            .flatten()
            .ok_or_else(|| changed(source, path))?;
        let (mut from, _) =
            sys::open_file_at(&from_parent, &from_name).map_err(|_| changed(source, path))?;
        let (sha256, size) = copy(&mut from, &mut file).map_err(failed)?;
        if sha256 != expected.sha256 || size != expected.size {
            return Err(changed(source, path));
        }
    }
    sys::set_mode(&file, source::mode_of(path)).map_err(failed)?;
    sys::flush(std::os::unix::io::AsRawFd::as_raw_fd(&file)).map_err(failed)
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

/// Reads the file `path` back from the tree open at `tree` (at `at`), through
/// exactly its spelling: the owner's regular file with its mode, holding
/// exactly what the release lists.
fn check(
    layout: &Layout,
    tree: &Fd,
    at: &Path,
    source: &Source,
    path: &str,
) -> Result<(), Problem> {
    let unverified = || Problem::Verify(at.join(path));
    let (parent, name) = tree::parent_of(tree, path, Some(layout.owner), How::Exact)
        .ok()
        .flatten()
        .ok_or_else(unverified)?;
    if !matches!(tree::spelled(&parent, &name), Ok(Spelled::Exact(_))) {
        return Err(unverified());
    }
    let (mut file, entry) = sys::open_file_at(&parent, &name).map_err(|_| unverified())?;
    if entry.owner != layout.owner
        || entry.mode != source::mode_of(path)
        || entry.kind != Kind::File
    {
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

/// Gives the work folder and every folder of this release's files in it the
/// mode 0755, so that any user reaches the installed files, and flushes each.
fn settle_folders(staging: &Fd, at: &Path, target: &[String]) -> Result<(), Problem> {
    let failed = |_| Problem::Write(at.to_path_buf());
    let folders: BTreeSet<&str> = target
        .iter()
        .flat_map(|path| path.match_indices('/').map(move |(end, _)| &path[..end]))
        .collect();
    for folder in folders {
        let (parent, name) = match tree::parent_of(staging, folder, None, How::Exact) {
            Ok(Some(found)) => found,
            _ => return Err(Problem::Verify(at.join(folder))),
        };
        let opened = sys::open_folder_at(&parent, &name).map_err(failed)?;
        sys::set_folder_mode(&opened, 0o755).map_err(failed)?;
        sys::flush(opened.raw()).map_err(failed)?;
    }
    sys::set_folder_mode(staging, 0o755).map_err(failed)?;
    sys::flush(staging.raw()).map_err(failed)
}
