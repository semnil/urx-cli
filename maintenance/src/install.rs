//! Installation, update and repair under K41 as revised (assembled beside
//! the root): one process, under the exclusive gate, admits and inspects,
//! records `installing` (this release's files, the tree's at the root and
//! its object), makes a work folder beside the root and records it, assembles
//! the complete release in it, each entry marked (`mark`), verifies that it
//! holds exactly the release, and puts it in place with one rename (a swap
//! with the previous tree, or a rename where no root is). It then removes the
//! previous tree, left at the work folder's name, by its recorded paths,
//! makes the command link, verifies everything and makes it durable, and
//! only then records `complete`, with the root's inode. Which
//! tree is at the root, and which at the work folder's name, is read from
//! the objects' inodes, so
//! an interruption at any point, a failed record update included, leaves
//! nothing the next run or a removal mistakes; the `installing` record keeps
//! the CLI from starting until the same release is installed again.

use crate::mark::Maker;
use crate::place::{self, Access, Layout, LinkState};
use crate::records::{pending_tag, Phase, State, Work, MANIFEST};
use crate::source::{self, Source};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::work::{self, Cleared};
use crate::{Problem, Report};
use std::collections::BTreeSet;
use std::ffi::{CStr, CString};
use std::io::Write;
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

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
    /// A tree of the installation's recorded files (all or some of them),
    /// and nothing else, to be replaced.
    Previous,
    /// Exactly this release, its folders' modes included, put in place by an
    /// interrupted run of this release.
    Target,
}

struct Inspection {
    action: Action,
    /// The files of the tree at the root, to replace (none when absent; this
    /// release's when it is `Target`).
    base: Vec<String>,
    root: Root,
    /// Which object the root is (its inode), when there is one.
    root_id: Option<u64>,
    /// The volume of the root's parent, when it is there.
    volume: Option<u64>,
    /// The work folder an interrupted run recorded, found at its name and
    /// still the recorded object, with what it holds.
    left: Option<Work>,
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
    let parent = match parent_now {
        Some(parent) => parent,
        None => place::root_parent(layout, true)?.expect("a made parent is open"),
    };
    let volume = match inspection.volume {
        Some(volume) => volume,
        None => place::volume_of(&parent, &layout.root)?,
    };
    let root_name = c_last(&layout.root);
    let mut report = Report::default();
    // The record of this run: this release's files, the tree's at the root and its object, and
    // the work folder once made.
    let record = |previous: Option<u64>, base: Vec<String>, work: Option<Work>| State {
        phase: Phase::Installing,
        release: release.clone(),
        manifest: digest.clone(),
        owned: target.clone(),
        base: Some(base),
        previous,
        root: None,
        work,
    };
    // The object the root is once this release is in place.
    let placed_id;
    if inspection.root == Root::Target {
        // The interrupted run's record stands: it names the release's object, now at the root,
        // and the previous tree's, at the work folder's name, which goes by its list.
        placed_id = inspection.root_id.expect("a root is there");
        if let Some(work) = &inspection.left {
            if let Cleared::Kept(kept) = work::clear(layout, &parent, volume, work)? {
                report.line(work::kept_line(layout, work, &kept));
            }
        }
    } else {
        // Record before writing (K41 step 2).
        held.write_state(&record(
            inspection.root_id,
            inspection.base.clone(),
            inspection.left.clone(),
        ))?;
        // What an interrupted run left at its work folder: the previous tree by its list, a
        // release partly assembled by its marks.
        if let Some(work) = &inspection.left {
            if let Cleared::Kept(kept) = work::clear(layout, &parent, volume, work)? {
                report.line(work::kept_line(layout, work, &kept));
            }
        }
        if stop() {
            return Err(Problem::Interrupted);
        }
        // A name nothing is at, other than the interrupted run's: a folder there the record does
        // not name is left as it is, and the release is assembled anew.
        let (staging_name, staging_path) = free_work_name(
            layout,
            &parent,
            &tag,
            state
                .as_ref()
                .and_then(|state| state.work.as_ref())
                .map(|work| work.name.as_str()),
        )?;
        let failed = |_| Problem::Write(staging_path.clone());
        // Root's alone while it is assembled.
        let staging = sys::make_folder_at(&parent, &staging_name, 0o700).map_err(failed)?;
        let staging_id = place::inode_on(
            &sys::entry(staging.raw()).map_err(failed)?,
            volume,
            &staging_path,
        )?;
        held.write_state(&record(
            inspection.root_id,
            inspection.base.clone(),
            Some(Work {
                name: staging_name.to_string_lossy().into_owned(),
                id: staging_id,
                files: target.clone(),
                check: true,
            }),
        ))?;
        // Assemble (step 3), every entry made marked, the manifest first.
        let mut maker = Maker::new(staging_id, volume);
        let order = target
            .iter()
            .filter(|path| *path == MANIFEST)
            .chain(target.iter().filter(|path| *path != MANIFEST));
        for path in order {
            if stop() {
                return Err(Problem::Interrupted);
            }
            put(layout, &staging, &staging_path, &source, path, &mut maker)?;
        }
        settle_folders(&staging, &staging_path, &target)?;
        for path in &target {
            check(layout, &staging, &staging_path, &source, path)?;
        }
        // Nothing but the release goes in place: anything else put in the work folder stops it
        // here, kept there, with the previous tree still at the root.
        let target_set: BTreeSet<String> = target.iter().cloned().collect();
        match tree::only_listed(&staging, "", &target_set, layout.owner) {
            Ok(Ok(())) => {}
            Ok(Err(entry)) => return Err(Problem::Conflict(staging_path.join(entry))),
            Err(_) => return Err(Problem::Verify(staging_path.clone())),
        }
        sys::flush(staging.raw()).map_err(failed)?;
        drop(staging);
        if stop() {
            return Err(Problem::Interrupted);
        }
        // The names are still the objects checked: the work folder made here, and the root
        // inspected (or nothing there).
        let at_name = |name: &CStr, path: &Path| {
            place::inode_at(&parent, name, volume, path).map(|found| found.map(|(inode, _)| inode))
        };
        if at_name(&staging_name, &staging_path)? != Some(staging_id) {
            return Err(Problem::Conflict(staging_path));
        }
        if at_name(&root_name, &layout.root)? != inspection.root_id {
            return Err(Problem::Conflict(layout.root.clone()));
        }
        // Put in place with one rename: the previous tree goes to the work folder's name. No
        // record follows: the objects' inodes, already recorded, say which is where.
        let placed = if inspection.root == Root::Absent {
            sys::rename_exclusive(&parent, &staging_name, &root_name)
        } else {
            sys::swap(&parent, &staging_name, &root_name)
        };
        placed.map_err(|_| Problem::Write(layout.root.clone()))?;
        sys::sync(parent.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
        placed_id = staging_id;
        if let Some(previous) = inspection.root_id {
            // The previous tree, now at the work folder's name, by its recorded paths.
            if stop() {
                return Err(Problem::Interrupted);
            }
            let swapped = Work {
                name: staging_name.to_string_lossy().into_owned(),
                id: previous,
                files: inspection.base.clone(),
                check: false,
            };
            if let Cleared::Kept(kept) = work::clear(layout, &parent, volume, &swapped)? {
                report.line(work::kept_line(layout, &swapped, &kept));
            }
        }
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    place::make_link(layout)?;
    // Verify and make durable (step 4): the root is the object put in place.
    let root = place::open_ours(&parent, &root_name, &layout.root, layout.owner)?
        .ok_or_else(|| Problem::Verify(layout.root.clone()))?;
    let root_entry = sys::entry(root.raw()).map_err(|_| Problem::Verify(layout.root.clone()))?;
    if place::inode_on(&root_entry, volume, &layout.root)? != placed_id {
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
        previous: None,
        root: Some(placed_id),
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

/// The first work folder name beside the root nothing is at, other than
/// `left` (the work folder an interrupted run left, even once it is gone):
/// the root's name, `.install-`, the tag, and a counter after the first.
fn free_work_name(
    layout: &Layout,
    parent: &Fd,
    tag: &str,
    left: Option<&str>,
) -> Result<(CString, PathBuf), Problem> {
    let first = place::staging(layout, tag);
    for count in 1..=64u32 {
        let path = if count == 1 {
            first.clone()
        } else {
            first.with_file_name(format!(
                "{}-{count}",
                first.file_name().unwrap_or_default().to_string_lossy()
            ))
        };
        let name = c_last(&path);
        if left.is_some_and(|left| left.as_bytes() == name.as_bytes()) {
            continue;
        }
        if sys::entry_at(parent, &name)
            .map_err(|_| Problem::Write(path.clone()))?
            .is_none()
        {
            return Ok((name, path));
        }
    }
    Err(Problem::Conflict(first))
}

/// The preflight (K41 step 1): what is installed, whether this release may
/// replace it, where each recorded tree is (read from the objects' inodes),
/// and that the root holds nothing but the files of the tree it is. Anything
/// else there stops it here, before the record changes, and is kept (K18).
fn inspect(
    layout: &Layout,
    parent: Option<&Fd>,
    source: &Source,
    state: Option<&State>,
) -> Result<Inspection, Problem> {
    let volume = match parent {
        Some(parent) => Some(place::volume_of(parent, &layout.root)?),
        None => None,
    };
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
    let root_id = match (&root, volume) {
        (Some(root), Some(volume)) => Some(place::inode_on(
            &sys::entry(root.raw()).map_err(|_| Problem::Conflict(layout.root.clone()))?,
            volume,
            &layout.root,
        )?),
        _ => None,
    };
    let target: BTreeSet<String> = source.manifest.owned().into_iter().collect();
    // Which tree is at the root, from the record and the root's inode: any other folder there
    // is not the installation's.
    let assembled = state
        .filter(|state| state.phase == Phase::Installing)
        .and_then(|state| state.work.as_ref())
        .filter(|work| work.check)
        .map(|work| work.id);
    let root_files: Vec<String> = match (state, root_id) {
        (_, None) | (None, _) => Vec::new(),
        (Some(state), Some(id)) => match state.phase {
            Phase::Installing if assembled == Some(id) => state.owned.clone(),
            Phase::Installing if state.previous == Some(id) => {
                state.base.clone().unwrap_or_default()
            }
            Phase::Complete | Phase::Removing if state.root == Some(id) => state.owned.clone(),
            _ => return Err(Problem::Conflict(layout.root.clone())),
        },
    };
    let (root_state, base) = match &root {
        None => (Root::Absent, Vec::new()),
        Some(root)
            if assembled.is_some()
                && assembled == root_id
                && is_release(layout, root, source, &target) =>
        {
            (Root::Target, root_files.clone())
        }
        Some(root) => {
            let files: BTreeSet<String> = root_files.iter().cloned().collect();
            match tree::only_listed(root, "", &files, layout.owner) {
                Ok(Ok(())) => {}
                Ok(Err(entry)) => return Err(Problem::Conflict(layout.root.join(entry))),
                Err(_) => return Err(Problem::Conflict(layout.root.clone())),
            }
            (Root::Previous, root_files.clone())
        }
    };
    // The recorded work folder, when it is still the recorded object at its name: what it holds
    // follows from which object it is.
    let left = match (parent, volume, state) {
        (Some(parent), Some(volume), Some(state)) => work::found(layout, parent, volume, state)?,
        _ => None,
    };
    Ok(Inspection {
        action,
        base,
        root: root_state,
        root_id,
        volume,
        left,
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

/// The open folder holding `path` in the work folder `staging`, and the
/// path's last name: each folder on the way one this run made, the missing
/// ones made marked. Anything else on the way is a conflict.
fn parent_made(
    staging: &Fd,
    path: &str,
    owner: u32,
    maker: &mut Maker,
) -> Result<(Fd, CString), WalkError> {
    let names: Vec<&str> = path.split('/').collect();
    let (last, folders) = names.split_last().expect("split gives one name at least");
    let mut current: Option<Fd> = None;
    let mut walked = String::new();
    for folder in folders {
        if !walked.is_empty() {
            walked.push('/');
        }
        walked.push_str(folder);
        let name = sys::c_name(folder.as_bytes())?;
        let parent = current.as_ref().unwrap_or(staging);
        let next = match tree::spelled(parent, &name)? {
            Spelled::Missing => match maker.new_folder(parent, &name) {
                Ok(made) => made,
                Err(error) if error.raw_os_error() == Some(libc::EEXIST) => {
                    return Err(WalkError::Conflict(walked))
                }
                Err(error) => return Err(WalkError::Io(error)),
            },
            Spelled::Exact(entry)
                if maker.made(&entry) && place::is_ours(&entry, Kind::Folder, owner) =>
            {
                sys::open_folder_at(parent, &name)?
            }
            _ => return Err(WalkError::Conflict(walked)),
        };
        current = Some(next);
    }
    let parent = match current {
        Some(folder) => folder,
        None => sys::duplicate(staging)?,
    };
    Ok((parent, sys::c_name(last.as_bytes())?))
}

/// Writes the owned file `path` from the source into the work folder
/// `staging` (at `at`), made by this run: made marked under a reserved name,
/// hashed as it is copied, given its mode and written through to the disk,
/// then moved to its path where nothing is. A file that no longer matches
/// the manifest stops the installation.
fn put(
    layout: &Layout,
    staging: &Fd,
    at: &Path,
    source: &Source,
    path: &str,
    maker: &mut Maker,
) -> Result<(), Problem> {
    let written = at.join(path);
    let (parent, name) = match parent_made(staging, path, layout.owner, maker) {
        Ok(found) => found,
        Err(WalkError::Conflict(conflict)) => return Err(Problem::Conflict(at.join(conflict))),
        Err(WalkError::Io(_)) => return Err(Problem::Write(written)),
    };
    let failed = |_| Problem::Write(written.clone());
    let (mut file, reserved) = maker.new_file(&parent).map_err(failed)?;
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
    sys::sync(std::os::unix::io::AsRawFd::as_raw_fd(&file)).map_err(failed)?;
    drop(file);
    sys::rename_exclusive(&parent, &reserved, &name).map_err(|error| {
        if error.raw_os_error() == Some(libc::EEXIST) {
            Problem::Conflict(written.clone())
        } else {
            Problem::Write(written.clone())
        }
    })
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
