//! The fixed places of a macOS installation (K18, K21) and the exclusive
//! gate maintenance runs under. Each place is opened from its system parent
//! by name, without following a link, and is used only when it is what
//! maintenance makes: a folder or file of the installation's owner that no
//! one else can write.

use crate::records::{State, PENDING_SUFFIX};
use crate::sys::{self, Entry, Fd, Kind};
use crate::Problem;
use std::ffi::{CStr, CString};
use std::io::{Read, Write};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};

/// Where an installation lives. `Layout::fixed` is the only one the tools
/// use; tests use folders of their own.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Layout {
    /// The installation root (K18).
    pub root: PathBuf,
    /// The command link (K18).
    pub link: PathBuf,
    /// The folder of the gate and the state record (K21).
    pub maintenance: PathBuf,
    /// The owner of everything maintenance makes (root).
    pub owner: u32,
    /// The highest folder whose permissions decide whether other users reach
    /// the installation: `/` for the fixed places.
    pub top: PathBuf,
}

impl Layout {
    /// The installation's fixed places on macOS.
    pub fn fixed() -> Layout {
        Layout {
            root: PathBuf::from("/usr/local/lib/urx-cli"),
            link: PathBuf::from("/usr/local/bin/urx"),
            maintenance: PathBuf::from("/Library/Application Support/urx-cli-maintenance"),
            owner: 0,
            top: PathBuf::from("/"),
        }
    }

    /// What the command link points to: the installed launcher.
    pub fn link_target(&self) -> PathBuf {
        self.root.join("bin").join("urx")
    }
}

const GATE: &str = "gate.lock";
const STATE: &str = "state.json";

/// The parent and the name of a fixed place.
fn split(path: &Path) -> (&Path, CString) {
    let parent = path.parent().unwrap_or(Path::new("/"));
    let name = path.file_name().map(|name| name.as_bytes()).unwrap_or(b"");
    (parent, CString::new(name).unwrap_or_default())
}

pub(crate) fn name(text: &str) -> CString {
    CString::new(text).unwrap_or_default()
}

/// The pending sibling of `name` that maintenance writes for the release
/// whose manifest digest starts with `tag` (`records::pending_tag`).
pub(crate) fn pending(name: &CStr, tag: &str) -> CString {
    let mut bytes = name.to_bytes().to_vec();
    bytes.extend_from_slice(PENDING_SUFFIX.as_bytes());
    bytes.push(b'-');
    bytes.extend_from_slice(tag.as_bytes());
    CString::new(bytes).unwrap_or_default()
}

/// A folder or file maintenance made: the owner's, and writable by no one else.
pub(crate) fn is_ours(entry: &Entry, kind: Kind, owner: u32) -> bool {
    entry.kind == kind && entry.owner == owner && entry.mode & 0o022 == 0
}

/// The maintenance folder, open, under the gate (K21): held until dropped,
/// and never unlocked early.
#[derive(Debug)]
pub struct Held {
    folder: Fd,
    _gate: std::fs::File,
    path: PathBuf,
    owner: u32,
}

/// How maintenance takes the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Access {
    /// A preview: a shared hold, which a running CLI does not block, and no
    /// folder or gate is made.
    Read,
    /// A change: an exclusive hold (K21). With `create`, a missing folder or
    /// gate is made (the first installation).
    Write { create: bool },
}

/// Opens the maintenance folder and its gate and takes the gate without
/// waiting. None when the folder or the gate is missing and is not to be
/// made: then nothing was ever installed, or the gate was removed.
pub fn hold(layout: &Layout, access: Access) -> Result<Option<Held>, Problem> {
    let path = &layout.maintenance;
    let create = access == Access::Write { create: true };
    let unusable = || Problem::Maintenance(path.clone());
    let (parent_path, folder_name) = split(path);
    let parent = sys::open_system_folder(parent_path).map_err(|_| unusable())?;
    let folder = match sys::entry_at(&parent, &folder_name).map_err(|_| unusable())? {
        None if create => {
            let folder =
                sys::make_folder_at(&parent, &folder_name, 0o755).map_err(|_| unusable())?;
            sys::sync(parent.raw()).map_err(|_| unusable())?;
            folder
        }
        None => return Ok(None),
        Some(entry) if is_ours(&entry, Kind::Folder, layout.owner) => {
            sys::open_folder_at(&parent, &folder_name).map_err(|_| unusable())?
        }
        Some(_) => return Err(unusable()),
    };
    // The folder opened is the one checked.
    if !is_ours(
        &sys::entry(folder.raw()).map_err(|_| unusable())?,
        Kind::Folder,
        layout.owner,
    ) {
        return Err(unusable());
    }
    let gate_name = name(GATE);
    let gate = match sys::entry_at(&folder, &gate_name).map_err(|_| unusable())? {
        None if create => {
            let gate = sys::create_file_at(&folder, &gate_name).map_err(|_| unusable())?;
            sys::set_mode(&gate, 0o644).map_err(|_| unusable())?;
            sys::sync(std::os::unix::io::AsRawFd::as_raw_fd(&gate)).map_err(|_| unusable())?;
            sys::sync(folder.raw()).map_err(|_| unusable())?;
            gate
        }
        None => return Ok(None),
        Some(_) => {
            let (gate, entry) = sys::open_file_at(&folder, &gate_name).map_err(|_| unusable())?;
            if !is_ours(&entry, Kind::File, layout.owner) || entry.size != 0 {
                return Err(unusable());
            }
            gate
        }
    };
    let fd = std::os::unix::io::AsRawFd::as_raw_fd(&gate);
    let operation = if access == Access::Read {
        libc::LOCK_SH
    } else {
        libc::LOCK_EX
    };
    // SAFETY: `fd` is open; the lock does not wait.
    if unsafe { libc::flock(fd, operation | libc::LOCK_NB) } != 0 {
        let error = std::io::Error::last_os_error();
        return Err(if error.raw_os_error() == Some(libc::EWOULDBLOCK) {
            Problem::Busy
        } else {
            unusable()
        });
    }
    // Held exclusively, the folder and the gate are given the modes every user's CLI needs to
    // reach and open the gate (K21); a refused hold changed nothing.
    if access != Access::Read {
        sys::set_folder_mode(&folder, 0o755).map_err(|_| unusable())?;
        sys::set_mode(&gate, 0o644).map_err(|_| unusable())?;
    }
    Ok(Some(Held {
        folder,
        _gate: gate,
        path: path.clone(),
        owner: layout.owner,
    }))
}

/// The longest state record read.
const STATE_LIMIT: u64 = 4 << 20;

impl Held {
    fn unusable(&self) -> Problem {
        Problem::Maintenance(self.path.clone())
    }

    /// The state record, None when there is none. A record in any other form
    /// than maintenance writes, or not the owner's, stops maintenance.
    pub fn state(&self, owner: u32) -> Result<Option<State>, Problem> {
        let state_name = name(STATE);
        if sys::entry_at(&self.folder, &state_name)
            .map_err(|_| self.unusable())?
            .is_none()
        {
            return Ok(None);
        }
        let (file, entry) =
            sys::open_file_at(&self.folder, &state_name).map_err(|_| self.unusable())?;
        if !is_ours(&entry, Kind::File, owner) || entry.size > STATE_LIMIT {
            return Err(self.unusable());
        }
        let mut bytes = Vec::new();
        file.take(STATE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| self.unusable())?;
        State::parse(&bytes)
            .map(Some)
            .ok_or_else(|| self.unusable())
    }

    /// Replaces the state record with `state`: written to a pending sibling,
    /// flushed, renamed over the record, and the folder flushed (K38).
    pub fn write_state(&self, state: &State) -> Result<(), Problem> {
        let state_name = name(STATE);
        let tag = crate::records::pending_tag(&state.manifest);
        let pending_name = pending(&state_name, tag);
        let failed = |_| Problem::Write(self.path.join(STATE));
        self.remove_pending_state(tag)?;
        let mut file = sys::create_file_at(&self.folder, &pending_name).map_err(failed)?;
        file.write_all(&state.to_bytes()).map_err(failed)?;
        sys::set_mode(&file, 0o644).map_err(failed)?;
        sys::sync(std::os::unix::io::AsRawFd::as_raw_fd(&file)).map_err(failed)?;
        drop(file);
        sys::rename_at(&self.folder, &pending_name, &state_name).map_err(failed)?;
        sys::sync(self.folder.raw()).map_err(failed)
    }

    /// Removes a pending state record that an interrupted write of a record
    /// for the release tagged `tag` left: a regular file of the owner under
    /// that tagged name. Anything else under it stops maintenance; any other
    /// name is left as it is.
    fn remove_pending_state(&self, tag: &str) -> Result<(), Problem> {
        let pending_name = pending(&name(STATE), tag);
        match sys::entry_at(&self.folder, &pending_name).map_err(|_| self.unusable())? {
            None => Ok(()),
            Some(entry) if entry.kind == Kind::File && entry.owner == self.owner => {
                sys::remove_at(&self.folder, &pending_name, false)
                    .map_err(|_| Problem::Write(self.path.join(STATE)))?;
                Ok(())
            }
            Some(_) => Err(self.unusable()),
        }
    }

    /// Removes the state record of the release tagged `tag`, keeping the
    /// gate and its folder (K21).
    pub fn remove_state(&self, tag: &str) -> Result<(), Problem> {
        let failed = |_| Problem::Write(self.path.join(STATE));
        self.remove_pending_state(tag)?;
        sys::remove_at(&self.folder, &name(STATE), false).map_err(failed)?;
        sys::sync(self.folder.raw()).map_err(failed)
    }
}

/// The installation root, open, or None when nothing is there. Anything but
/// a folder maintenance made is a conflict (K18). With `create`, a missing
/// root is made, and its missing system parents with it.
pub fn open_root(layout: &Layout, create: bool) -> Result<Option<Fd>, Problem> {
    let (parent_path, root_name) = split(&layout.root);
    if create {
        make_system_folders(parent_path).map_err(|_| Problem::Write(parent_path.to_path_buf()))?;
    }
    let parent = match sys::open_system_folder(parent_path) {
        Ok(parent) => parent,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) && !create => return Ok(None),
        Err(_) => return Err(Problem::Conflict(parent_path.to_path_buf())),
    };
    let conflict = || Problem::Conflict(layout.root.clone());
    let root = match sys::entry_at(&parent, &root_name).map_err(|_| conflict())? {
        None if create => {
            let root = sys::make_folder_at(&parent, &root_name, 0o755)
                .map_err(|_| Problem::Write(layout.root.clone()))?;
            sys::sync(parent.raw()).map_err(|_| Problem::Write(layout.root.clone()))?;
            root
        }
        None => return Ok(None),
        Some(entry) if is_ours(&entry, Kind::Folder, layout.owner) => {
            sys::open_folder_at(&parent, &root_name).map_err(|_| conflict())?
        }
        Some(_) => return Err(conflict()),
    };
    if !is_ours(
        &sys::entry(root.raw()).map_err(|_| conflict())?,
        Kind::Folder,
        layout.owner,
    ) {
        return Err(conflict());
    }
    Ok(Some(root))
}

/// Checks that only root (the layout's owner) can change the folder the root
/// is in and the one the maintenance folder is in, and every folder above
/// them up to the layout's top, links resolved: the installation's names are
/// made, swapped and removed there, so anyone else who could write one could
/// change them between a check and the change it guards. As far as the
/// folders exist; a missing one is made by root.
pub fn check_not_exposed(layout: &Layout) -> Result<(), Problem> {
    let top = std::fs::canonicalize(&layout.top).unwrap_or_else(|_| layout.top.clone());
    for place in [&layout.root, &layout.maintenance] {
        let Some(parent) = place.parent() else {
            continue;
        };
        let Some(existing) = parent
            .ancestors()
            .find(|folder| std::fs::symlink_metadata(folder).is_ok())
        else {
            continue;
        };
        let real = std::fs::canonicalize(existing)
            .map_err(|_| Problem::Exposed(existing.to_path_buf()))?;
        for folder in real.ancestors() {
            if !folder.starts_with(&top) {
                break;
            }
            let found =
                std::fs::metadata(folder).map_err(|_| Problem::Exposed(folder.to_path_buf()))?;
            let owner = std::os::unix::fs::MetadataExt::uid(&found);
            let mode = std::os::unix::fs::MetadataExt::mode(&found);
            if (owner != 0 && owner != layout.owner) || mode & 0o022 != 0 {
                return Err(Problem::Exposed(folder.to_path_buf()));
            }
        }
    }
    Ok(())
}

/// The work folder beside the root where the release whose manifest digest
/// starts with `tag` is assembled, and where the previous tree is left by
/// the swap that puts the release in place (K41 as revised).
pub fn staging(layout: &Layout, tag: &str) -> PathBuf {
    let name = layout
        .root
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    layout.root.with_file_name(format!("{name}.install-{tag}"))
}

/// The root's parent folder, open; with `create`, made with its missing
/// system parents, each 0755. None when it is missing and not to be made.
pub fn root_parent(layout: &Layout, create: bool) -> Result<Option<Fd>, Problem> {
    let (parent_path, _) = split(&layout.root);
    if create {
        make_system_folders(parent_path).map_err(|_| Problem::Write(parent_path.to_path_buf()))?;
    }
    match sys::open_system_folder(parent_path) {
        Ok(parent) => Ok(Some(parent)),
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) && !create => Ok(None),
        Err(_) => Err(Problem::Conflict(parent_path.to_path_buf())),
    }
}

/// The folder `name` in the open folder `parent` (at `path`) when it is one
/// maintenance made; None when nothing is there; anything else is a conflict.
pub fn open_ours(parent: &Fd, name: &CStr, path: &Path, owner: u32) -> Result<Option<Fd>, Problem> {
    let conflict = || Problem::Conflict(path.to_path_buf());
    match sys::entry_at(parent, name).map_err(|_| conflict())? {
        None => Ok(None),
        Some(entry) if is_ours(&entry, Kind::Folder, owner) => {
            let folder = sys::open_folder_at(parent, name).map_err(|_| conflict())?;
            if is_ours(
                &sys::entry(folder.raw()).map_err(|_| conflict())?,
                Kind::Folder,
                owner,
            ) {
                Ok(Some(folder))
            } else {
                Err(conflict())
            }
        }
        Some(_) => Err(conflict()),
    }
}

/// What is at the command link's path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkState {
    /// Nothing.
    Missing,
    /// A link to the installed launcher: the installation's own (K18).
    Owned,
    /// Anything else: a file, a folder, or a link to somewhere else.
    Foreign,
}

/// The command link's state. Only a link whose target is exactly the
/// installed launcher is the installation's.
pub fn link_state(layout: &Layout) -> Result<LinkState, Problem> {
    let (parent_path, link_name) = split(&layout.link);
    let parent = match sys::open_system_folder(parent_path) {
        Ok(parent) => parent,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(LinkState::Missing),
        Err(_) => return Err(Problem::Conflict(parent_path.to_path_buf())),
    };
    link_state_in(&parent, &link_name, layout)
}

fn link_state_in(parent: &Fd, link_name: &CStr, layout: &Layout) -> Result<LinkState, Problem> {
    let conflict = || Problem::Conflict(layout.link.clone());
    match sys::entry_at(parent, link_name).map_err(|_| conflict())? {
        None => Ok(LinkState::Missing),
        Some(entry) if entry.kind == Kind::Link => {
            let target = sys::link_target_at(parent, link_name).map_err(|_| conflict())?;
            Ok(if target == layout.link_target().as_os_str().as_bytes() {
                LinkState::Owned
            } else {
                LinkState::Foreign
            })
        }
        Some(_) => Ok(LinkState::Foreign),
    }
}

/// Makes the command link where nothing is, its missing system parent with
/// it; a link already the installation's is kept.
pub fn make_link(layout: &Layout) -> Result<(), Problem> {
    let (parent_path, link_name) = split(&layout.link);
    let failed = || Problem::Write(layout.link.clone());
    make_system_folders(parent_path).map_err(|_| failed())?;
    let parent = sys::open_system_folder(parent_path).map_err(|_| failed())?;
    match link_state_in(&parent, &link_name, layout)? {
        LinkState::Owned => Ok(()),
        LinkState::Foreign => Err(Problem::Conflict(layout.link.clone())),
        LinkState::Missing => {
            let target =
                sys::c_name(layout.link_target().as_os_str().as_bytes()).map_err(|_| failed())?;
            sys::make_link_at(&parent, &link_name, &target).map_err(|_| failed())?;
            sys::sync(parent.raw()).map_err(|_| failed())
        }
    }
}

/// Removes the command link when it is still the installation's; anything
/// else there is kept. True when it was removed.
pub fn remove_link(layout: &Layout) -> Result<bool, Problem> {
    let (parent_path, link_name) = split(&layout.link);
    let parent = match sys::open_system_folder(parent_path) {
        Ok(parent) => parent,
        Err(error) if error.raw_os_error() == Some(libc::ENOENT) => return Ok(false),
        Err(_) => return Err(Problem::Conflict(parent_path.to_path_buf())),
    };
    if link_state_in(&parent, &link_name, layout)? != LinkState::Owned {
        return Ok(false);
    }
    let failed = |_| Problem::Write(layout.link.clone());
    sys::remove_at(&parent, &link_name, false).map_err(failed)?;
    sys::sync(parent.raw()).map_err(failed)?;
    Ok(true)
}

/// Makes the missing folders of the absolute `path`, each 0755 whatever the
/// umask, so that every user passes through them.
fn make_system_folders(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let missing: Vec<&Path> = path
        .ancestors()
        .take_while(|folder| std::fs::symlink_metadata(folder).is_err())
        .collect();
    for folder in missing.into_iter().rev() {
        std::fs::create_dir(folder)?;
        std::fs::set_permissions(folder, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(())
}

/// Whether reachability is judged here: only root can ask the system as
/// another user, so only a run as root for the fixed places judges it.
pub fn judges_reachability(layout: &Layout) -> bool {
    sys::effective_user() == 0 && layout.owner == 0
}

/// Checks that every user reaches the installation, by asking the system: a
/// child process switched to the user nobody tries each place as the system
/// resolves it, links and `..` included. Before any change (`installed`
/// false) the folders above the root, the command link and the maintenance
/// folder are tried, as far as they exist (the rest is made 0755); once
/// installed, the command through its link, the runtime, the CLI, the addon,
/// the release manifest, the gate and the state record too. Run as anyone
/// but root it judges nothing (`judges_reachability`): the preview says so.
pub fn check_reachable(layout: &Layout, installed: bool) -> Result<(), Problem> {
    if !judges_reachability(layout) {
        return Ok(());
    }
    let mut folders: Vec<PathBuf> = [&layout.root, &layout.link, &layout.maintenance]
        .iter()
        .filter_map(|place| place.parent())
        .map(Path::to_path_buf)
        .collect();
    if installed {
        folders.extend([layout.root.clone(), layout.maintenance.clone()]);
    }
    let mut checks: Vec<(PathBuf, sys::Need)> = folders
        .iter()
        .filter_map(|folder| {
            folder
                .ancestors()
                .find(|ancestor| std::fs::symlink_metadata(ancestor).is_ok())
        })
        .map(|folder| (folder.to_path_buf(), sys::Need::Execute))
        .collect();
    if installed {
        checks.extend([
            (layout.link.clone(), sys::Need::Execute),
            (layout.root.join("runtime/node"), sys::Need::Execute),
            (layout.root.join("app/main.js"), sys::Need::Read),
            (layout.root.join("native/urx-native.node"), sys::Need::Read),
            (layout.root.join(crate::records::MANIFEST), sys::Need::Read),
            (layout.maintenance.join(GATE), sys::Need::Read),
            (layout.maintenance.join(STATE), sys::Need::Read),
        ]);
    }
    let named: Vec<(CString, sys::Need)> = checks
        .iter()
        .map(|(path, need)| {
            (
                CString::new(path.as_os_str().as_bytes()).unwrap_or_default(),
                *need,
            )
        })
        .collect();
    match sys::reachable_as_nobody(&named) {
        Ok(None) => Ok(()),
        Ok(Some(index)) => Err(Problem::Unreachable(checks[index].0.clone())),
        Err(_) => Err(Problem::Unreachable(layout.root.clone())),
    }
}
