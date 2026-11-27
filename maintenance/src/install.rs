//! Installation, update and repair under K41: one process, under the
//! exclusive gate, admits and inspects, records `installing`, removes the
//! files only the previous release had, copies the release's files, removes
//! the previous spellings of files whose name changed only in letter case,
//! makes the command link, verifies everything and makes it durable, and
//! only then records `complete`. A failure or an interruption before that
//! leaves the `installing` record, which keeps the CLI from starting until
//! the same release is installed again.

use crate::place::{self, Access, Layout, LinkState};
use crate::records::{key, Phase, State, MANIFEST};
use crate::source::{self, Source};
use crate::sys::{self, Fd, Kind};
use crate::tree::{self, How, Spelled, WalkError};
use crate::{Problem, Report};
use std::collections::BTreeSet;
use std::ffi::CStr;
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

/// The changes an apply makes to the files, from what is installed and what
/// this release lists.
struct Changes {
    /// This release's files.
    target: Vec<String>,
    /// Owned now and not this release's under any spelling: removed before
    /// copying, which clears a place where this release has a folder for a
    /// file or a file for a folder.
    gone: Vec<String>,
    /// Owned now under another letter case of one of this release's paths:
    /// that spelling is removed after copying, where it is still another file.
    respelled: Vec<String>,
}

impl Changes {
    fn of(previous: &[String], target: Vec<String>) -> Changes {
        let target_keys: BTreeSet<String> = target.iter().map(|path| key(path)).collect();
        let (respelled, gone) = previous
            .iter()
            .filter(|path| target.binary_search(path).is_err())
            .cloned()
            .partition(|path| target_keys.contains(&key(path)));
        Changes {
            target,
            gone,
            respelled,
        }
    }
}

struct Inspection {
    action: Action,
    /// Every path the installation may own now.
    previous: Vec<String>,
    /// The paths of the complete installation the run starts from, or started
    /// from when it was interrupted.
    base: Vec<String>,
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
    place::check_reachable(layout, false)?;
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
    let changes = Changes::of(&inspection.previous, source.manifest.owned());
    let digest = source.digest();
    if stop() {
        return Err(Problem::Interrupted);
    }
    // Record before writing (K41 step 2): every path that may be owned, and
    // which of them the complete installation owned.
    let mut owned = inspection.previous.clone();
    owned.extend(changes.target.iter().cloned());
    owned.sort_unstable();
    owned.dedup();
    held.write_state(&State {
        phase: Phase::Installing,
        release: release.clone(),
        manifest: digest.clone(),
        owned,
        base: Some(inspection.base.clone()),
    })?;
    let tag = crate::records::pending_tag(&digest).to_owned();
    let root = place::open_root(layout, true)?.expect("a created root is open");
    // Mutate (step 3): what goes, then what comes, then the old spellings.
    for path in &changes.gone {
        if stop() {
            return Err(Problem::Interrupted);
        }
        crate::remove::remove_owned(layout, &root, path, &tag, None)?;
        crate::remove::prune(layout, &root, path)?;
    }
    // The manifest first: it is what tells the installation's new files from others afterwards.
    let order = changes
        .target
        .iter()
        .filter(|path| *path == MANIFEST)
        .chain(changes.target.iter().filter(|path| *path != MANIFEST));
    for path in order {
        if stop() {
            return Err(Problem::Interrupted);
        }
        put(layout, &root, &source, path, &tag)?;
    }
    for path in &changes.respelled {
        if stop() {
            return Err(Problem::Interrupted);
        }
        crate::remove::remove_owned(layout, &root, path, &tag, None)?;
        crate::remove::prune(layout, &root, path)?;
    }
    if stop() {
        return Err(Problem::Interrupted);
    }
    place::make_link(layout)?;
    // Verify and make durable (step 4).
    settle_folders(layout, &root, &changes.target)?;
    for path in &changes.target {
        check(layout, &root, &source, path)?;
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
        owned: changes.target,
        base: None,
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
/// replace it, and that the apply would change nothing that is not the
/// installation's. Something else where this release's files go stops it
/// here, before the record changes, with the installed release as it was.
fn inspect(layout: &Layout, source: &Source, state: Option<&State>) -> Result<Inspection, Problem> {
    let root = place::open_root(layout, false)?;
    let link = place::link_state(layout)?;
    if link == LinkState::Foreign {
        return Err(Problem::Conflict(layout.link.clone()));
    }
    let digest = source.digest();
    let (action, previous, base) = match state {
        None => {
            if root.is_some() {
                return Err(Problem::Unrecorded(layout.root.clone()));
            }
            (Action::Install, Vec::new(), Vec::new())
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
            (action, state.owned.clone(), state.base_paths().to_vec())
        }
    };
    let Some(root) = root else {
        return Ok(Inspection {
            action,
            previous,
            base,
            link,
        });
    };
    let changes = Changes::of(&previous, source.manifest.owned());
    let plan = Plan::new(&previous, &base, &changes);
    for path in &changes.target {
        plan.clear_for(layout, &root, source, path)
            .map_err(|at| Problem::Conflict(layout.root.join(at)))?;
    }
    Ok(Inspection {
        action,
        previous,
        base,
        link,
    })
}

/// What the preflight knows of the installation's own entries.
struct Plan {
    /// Folders the installation owns: the folders of every path it may own, by `key`.
    folders: BTreeSet<String>,
    /// Paths whose files are the installation's whatever they hold, by `key`.
    base: BTreeSet<String>,
    /// Paths the installation may own whose files are its own only as this
    /// release lists them, by `key`.
    added: BTreeSet<String>,
    /// The files that go before this release's are written, exactly as
    /// spelled, and their folders.
    gone_files: BTreeSet<String>,
    gone_folders: BTreeSet<String>,
}

fn folders_of(path: &str) -> impl Iterator<Item = &str> {
    path.match_indices('/').map(move |(at, _)| &path[..at])
}

impl Plan {
    fn new(previous: &[String], base: &[String], changes: &Changes) -> Plan {
        let base_keys: BTreeSet<String> = base.iter().map(|path| key(path)).collect();
        Plan {
            folders: previous
                .iter()
                .flat_map(|path| folders_of(path))
                .map(key)
                .collect(),
            added: previous
                .iter()
                .map(|path| key(path))
                .filter(|path| !base_keys.contains(path))
                .collect(),
            base: base_keys,
            gone_files: changes.gone.iter().cloned().collect(),
            gone_folders: changes
                .gone
                .iter()
                .flat_map(|path| folders_of(path))
                .map(str::to_owned)
                .collect(),
        }
    }

    /// Whether this release's file `path` has its place: each folder on the
    /// way is one the installation owns, or missing, or a file that goes
    /// first; the file's own place is empty, holds the installation's file
    /// (a file of the complete installation, or one as this release lists
    /// it), or is a folder of the installation's that the files going leave
    /// empty. The path of the first thing in the way otherwise.
    fn clear_for(
        &self,
        layout: &Layout,
        root: &Fd,
        source: &Source,
        path: &str,
    ) -> Result<(), String> {
        let names: Vec<&str> = path.split('/').collect();
        let mut folder: Option<Fd> = None;
        let mut walked = String::new();
        for (index, name) in names.iter().enumerate() {
            let prefix = walked.clone();
            if !walked.is_empty() {
                walked.push('/');
            }
            walked.push_str(name);
            let c_name = sys::c_name(name.as_bytes()).map_err(|_| walked.clone())?;
            let parent = folder.as_ref().unwrap_or(root);
            let found = tree::spelled(parent, &c_name).map_err(|_| walked.clone())?;
            // The entry, and its path as the folder spells it.
            let (entry, actual) = match &found {
                Spelled::Missing => return Ok(()),
                Spelled::Exact(entry) => (*entry, walked.clone()),
                Spelled::Other { entry, actual } => {
                    let Some(actual) = actual.as_ref().and_then(|actual| actual.to_str().ok())
                    else {
                        return Err(walked);
                    };
                    let spelled = if prefix.is_empty() {
                        actual.to_owned()
                    } else {
                        format!("{prefix}/{actual}")
                    };
                    (*entry, spelled)
                }
            };
            let last = index + 1 == names.len();
            let ours_folder = place::is_ours(&entry, Kind::Folder, layout.owner)
                && self.folders.contains(&key(&walked));
            match entry.kind {
                Kind::Folder if !ours_folder => return Err(walked),
                Kind::Folder if !last => {
                    folder =
                        Some(sys::open_folder_at(parent, &c_name).map_err(|_| walked.clone())?);
                }
                Kind::Folder => {
                    // A folder that becomes a file: only one the files going leave empty.
                    let inner = sys::open_folder_at(parent, &c_name).map_err(|_| walked.clone())?;
                    return match self.holds_only_gone(&inner, &format!("{actual}/")) {
                        Ok(true) if self.gone_folders.contains(&actual) => Ok(()),
                        _ => Err(walked),
                    };
                }
                // A file that becomes a folder: only one that goes first, under that spelling.
                Kind::File if !last && self.gone_files.contains(&actual) => return Ok(()),
                Kind::File | Kind::Link if last && self.base.contains(&key(&walked)) => {
                    return Ok(())
                }
                // A file a run of this release wrote before it was interrupted: only as the release lists it.
                Kind::File if last && self.added.contains(&key(&walked)) => {
                    return if listed_file(source, path, parent, &c_name) {
                        Ok(())
                    } else {
                        Err(walked)
                    };
                }
                _ => return Err(walked),
            }
        }
        Ok(())
    }

    /// Whether everything under the open folder `folder` (at `prefix`, ending
    /// with `/`, as spelled) is a file that goes or a folder of one, under
    /// exactly that spelling.
    fn holds_only_gone(&self, folder: &Fd, prefix: &str) -> std::io::Result<bool> {
        for name in sys::names(folder)? {
            let Ok(text) = std::str::from_utf8(name.to_bytes()) else {
                return Ok(false);
            };
            let path = format!("{prefix}{text}");
            match sys::entry_at(folder, &name)?.map(|entry| entry.kind) {
                Some(Kind::File) if self.gone_files.contains(&path) => {}
                Some(Kind::Folder) if self.gone_folders.contains(&path) => {
                    if !self.holds_only_gone(
                        &sys::open_folder_at(folder, &name)?,
                        &format!("{path}/"),
                    )? {
                        return Ok(false);
                    }
                }
                None => {}
                Some(_) => return Ok(false),
            }
        }
        Ok(true)
    }
}

/// Whether the file `name` in `parent` holds exactly what this release lists for `path`.
fn listed_file(source: &Source, path: &str, parent: &Fd, name: &CStr) -> bool {
    let Ok((mut file, _)) = sys::open_file_at(parent, name) else {
        return false;
    };
    let Ok((sha256, size)) = tree::hash(&mut file) else {
        return false;
    };
    if path == MANIFEST {
        sha256 == source.digest() && size == source.manifest_bytes.len() as u64
    } else {
        source
            .manifest
            .files
            .iter()
            .any(|file| file.path == path && file.sha256 == sha256 && file.size == size)
    }
}

/// Writes the owned file `path` from the source: to a pending sibling,
/// hashed as it is copied, given its mode and flushed, then renamed into
/// place under exactly this path's spelling. A file that no longer matches
/// the manifest stops the installation.
fn put(layout: &Layout, root: &Fd, source: &Source, path: &str, tag: &str) -> Result<(), Problem> {
    let at = layout.root.join(path);
    let (parent, name) = match tree::parent_of(root, path, Some(layout.owner), How::Make) {
        Ok(found) => found.expect("missing folders are made"),
        Err(WalkError::Conflict(conflict)) => {
            return Err(Problem::Conflict(layout.root.join(conflict)))
        }
        Err(WalkError::Io(_)) => return Err(Problem::Write(at)),
    };
    let failed = |_| Problem::Write(at.clone());
    // A pending file with this release's tag is one a run of this release left.
    let pending = place::pending(&name, tag);
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
        let (from_parent, from_name) = tree::parent_of(&source.root, path, None, How::Lookup)
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
    match tree::spelled(&parent, &name).map_err(failed)? {
        Spelled::Exact(entry) | Spelled::Other { entry, .. } if entry.kind == Kind::Folder => {
            let _ = sys::remove_at(&parent, &pending, false);
            return Err(Problem::Conflict(at));
        }
        // The installation's file under another letter case: given this spelling first, since
        // a rename over it would keep the old one.
        Spelled::Other {
            actual: Some(actual),
            ..
        } => sys::rename_at(&parent, &actual, &name).map_err(failed)?,
        Spelled::Other { actual: None, .. } => {
            let _ = sys::remove_at(&parent, &pending, false);
            return Err(Problem::Conflict(at));
        }
        Spelled::Missing | Spelled::Exact(_) => {}
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

/// Reads the installed file `path` back, through exactly its spelling: the
/// owner's regular file with its mode, holding exactly what the release lists.
fn check(layout: &Layout, root: &Fd, source: &Source, path: &str) -> Result<(), Problem> {
    let at = layout.root.join(path);
    let unverified = || Problem::Verify(at.clone());
    let (parent, name) = tree::parent_of(root, path, Some(layout.owner), How::Exact)
        .ok()
        .flatten()
        .ok_or_else(unverified)?;
    if !matches!(tree::spelled(&parent, &name), Ok(Spelled::Exact(_))) {
        return Err(unverified());
    }
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

/// Gives the root and every folder of this release's files the mode 0755,
/// whatever it had, so that any user reaches the installed files, and
/// flushes each, so that each name made or removed in it is on the disk.
/// Folders the installation does not use are left as they are.
fn settle_folders(layout: &Layout, root: &Fd, target: &[String]) -> Result<(), Problem> {
    let failed = |_| Problem::Write(layout.root.clone());
    let folders: BTreeSet<&str> = target.iter().flat_map(|path| folders_of(path)).collect();
    for folder in folders {
        let (parent, name) = match tree::parent_of(root, folder, Some(layout.owner), How::Exact) {
            Ok(Some(found)) => found,
            _ => return Err(Problem::Verify(layout.root.join(folder))),
        };
        let opened = sys::open_folder_at(&parent, &name).map_err(failed)?;
        sys::set_folder_mode(&opened, 0o755).map_err(failed)?;
        sys::flush(opened.raw()).map_err(failed)?;
    }
    sys::set_folder_mode(root, 0o755).map_err(failed)?;
    sys::flush(root.raw()).map_err(failed)
}
