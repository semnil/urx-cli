//! The installed `urx` command (K18, K21, K22, K24, K38): it takes the
//! installation's shared use protection, checks that this bundle is the
//! complete installation, removes inherited `NODE_` variables and hands the
//! user's arguments, unchanged, to the bundled Node running the CLI. It parses
//! no command and formats no result. A failure before Node starts exits 1 with
//! nothing on standard output and one plain-English line on standard error,
//! naming no path or value.

pub mod env;
pub mod gate;
pub mod handoff;
pub mod install;

use gate::{Gate, GateFailure};
use install::{Bundle, InstallFailure};
use std::ffi::OsString;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

/// Why the launcher could not start the CLI.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    Gate(GateFailure),
    Install(InstallFailure),
    /// The launcher could not tell where its own bundle is.
    Location,
    /// The runtime could not be started.
    Start,
}

impl Failure {
    /// The one line reported on standard error: the known cause and what to do.
    pub fn message(self) -> &'static str {
        match self {
            Failure::Gate(GateFailure::Busy) => "urx: urx is being installed, updated or removed. Try again once that has finished.",
            Failure::Gate(GateFailure::Missing) | Failure::Install(InstallFailure::Incomplete) => {
                "urx: The installation is incomplete or damaged. Run the urx installer again to repair it."
            }
            Failure::Gate(GateFailure::Unusable) => "urx: The installation's lock file cannot be used. Run the urx installer again to repair it.",
            Failure::Location => "urx: The installation could not be located. Run urx from its installed location.",
            Failure::Start => "urx: The bundled runtime could not be started. Run the urx installer again if this persists.",
        }
    }
}

/// Where the launcher finds its installation.
pub struct Installation {
    /// The directory holding the gate and the state record (K21).
    pub maintenance: PathBuf,
    /// The bundle the launcher belongs to.
    pub bundle: Bundle,
    /// The owner the gate must have, where the platform fixes one (macOS: root).
    pub owner: Option<u32>,
}

/// The fixed maintenance directory of this platform (K21).
#[cfg(unix)]
pub fn maintenance_directory() -> Option<PathBuf> {
    Some(PathBuf::from(
        "/Library/Application Support/urx-cli-maintenance",
    ))
}

/// The fixed maintenance directory of this platform (K21): in the current
/// user's local application-data folder.
#[cfg(windows)]
pub fn maintenance_directory() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::{FOLDERID_LocalAppData, SHGetKnownFolderPath};
    let mut path: *mut u16 = std::ptr::null_mut();
    // SAFETY: the folder ID is valid; the call allocates `path`, freed below.
    let result =
        unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, std::ptr::null_mut(), &mut path) };
    if result != 0 || path.is_null() {
        return None;
    }
    // SAFETY: `path` is a NUL-terminated wide string from the call above.
    let length = (0..).take_while(|&i| unsafe { *path.add(i) } != 0).count();
    // SAFETY: `length` units are readable at `path`.
    let folder = OsString::from_wide(unsafe { std::slice::from_raw_parts(path, length) });
    // SAFETY: `path` was allocated by SHGetKnownFolderPath.
    unsafe { CoTaskMemFree(path as *const core::ffi::c_void) };
    Some(PathBuf::from(folder).join("urx-cli-maintenance"))
}

/// The installed launcher's own installation.
pub fn installed() -> Result<Installation, Failure> {
    let launcher = std::env::current_exe()
        .and_then(|path| path.canonicalize())
        .map_err(|_| Failure::Location)?;
    let bundle = Bundle::of_launcher(&launcher).ok_or(Failure::Location)?;
    let maintenance = maintenance_directory().ok_or(Failure::Location)?;
    Ok(Installation {
        maintenance,
        bundle,
        owner: if cfg!(target_os = "macos") {
            Some(0)
        } else {
            None
        },
    })
}

/// What a successful start leaves to the caller.
pub enum Started {
    /// The runtime ran as a child and exited with this code (Windows). On
    /// macOS the runtime replaced the launcher, so nothing returns.
    #[cfg_attr(unix, allow(dead_code))]
    Exited(u32),
}

/// Takes the protection, checks the installation and starts the runtime with
/// `arguments` and `environment` (before `NODE_` removal). On macOS a success
/// does not return.
pub fn launch(
    installation: &Installation,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
) -> Result<Started, Failure> {
    let gate = Gate::open(
        &gate::gate_path(&installation.maintenance),
        installation.owner,
    )
    .map_err(Failure::Gate)?;
    install::verify(&installation.maintenance, &installation.bundle).map_err(Failure::Install)?;
    let runtime = installation.bundle.runtime();
    let entry = installation.bundle.entry();
    let start = handoff::Start {
        runtime: &runtime,
        entry: &entry,
        arguments,
        environment: env::without_node(environment, env::CASE_INSENSITIVE),
    };
    run(&gate, start)
}

#[cfg(unix)]
fn run(gate: &Gate, start: handoff::Start<'_>) -> Result<Started, Failure> {
    let _error = handoff::hand_off(gate, start);
    Err(Failure::Start)
}

#[cfg(windows)]
fn run(gate: &Gate, start: handoff::Start<'_>) -> Result<Started, Failure> {
    handoff::hand_off(gate, start)
        .map(Started::Exited)
        .map_err(|_| Failure::Start)
}

/// Writes one line to standard error within the output deadline (O7); a
/// broken or blocked standard error is given up rather than waited for.
pub fn report(failure: Failure) {
    let line = format!("{}\n", failure.message());
    let (done, finished) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut stderr = std::io::stderr().lock();
        let _ = stderr
            .write_all(line.as_bytes())
            .and_then(|()| stderr.flush());
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(Duration::from_secs(5));
}

/// The installed command: everything after the program name is the CLI's.
pub fn start() -> ! {
    let arguments: Vec<OsString> = std::env::args_os().skip(1).collect();
    let environment: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    let outcome =
        installed().and_then(|installation| launch(&installation, arguments, environment));
    match outcome {
        Ok(Started::Exited(code)) => std::process::exit(code as i32),
        Err(failure) => {
            report(failure);
            std::process::exit(1)
        }
    }
}
