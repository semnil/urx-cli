//! The macOS maintenance tools of urx-cli (K20, K41): `urx-install`, which
//! installs, updates or repairs the installation from the release tree beside
//! it in the disk image, and `urx-uninstall`, which removes it. Each is one
//! native process that makes every change itself, under the installation's
//! exclusive gate, and changes only what the installation owns. Neither
//! loads Node, the addon or the CLI, or touches a device.

#[cfg(unix)]
pub mod install;
#[cfg(unix)]
pub mod interrupt;
#[cfg(unix)]
pub mod journal;
#[cfg(unix)]
pub mod place;
pub mod records;
#[cfg(unix)]
pub mod remove;
#[cfg(unix)]
pub mod source;
#[cfg(unix)]
pub mod sys;
#[cfg(unix)]
pub mod tree;
#[cfg(unix)]
pub mod work;

use std::path::PathBuf;

/// Why maintenance stopped. Each names what to do next.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// An apply was run without administrator privileges.
    NotAdministrator,
    /// The gate is held: a CLI is running, or another maintenance is.
    Busy,
    /// The maintenance folder, its gate or its state record is not what
    /// maintenance makes.
    Maintenance(PathBuf),
    /// Something foreign is where the installation goes (K18).
    Conflict(PathBuf),
    /// The root is there without a state record, so what it owns is not known.
    Unrecorded(PathBuf),
    /// An installation or removal of another release was interrupted; only
    /// that release's installer, or the removal, finishes it (K19).
    Unfinished { release: String },
    /// The release tree is not the one the installer was built for, or not
    /// as its manifest lists it.
    Source(String),
    /// This installer was built without a release manifest to install.
    NotRelease,
    /// A change could not be made at this path.
    Write(PathBuf),
    /// An installed file or the link is not what was installed.
    Verify(PathBuf),
    /// Ctrl+C (or a termination signal) arrived; nothing more was changed.
    Interrupted,
    /// Other users cannot pass through this folder, so they could not reach
    /// the command, the installed files or the gate.
    Unreachable(PathBuf),
    /// Someone other than root could change this folder, in which the
    /// installation's names are made and swapped.
    Exposed(PathBuf),
    /// A removal stopped after the installed removal tool was removed, by an
    /// interruption or a failed change: another copy of it finishes the removal.
    RemovalUnfinished { interrupted: bool },
}

impl Problem {
    /// The plain-English explanation, with what to do.
    pub fn message(&self) -> String {
        match self {
            Problem::NotAdministrator => {
                "It changes system folders, so run it with sudo.".to_owned()
            }
            Problem::Busy => "urx is running, or urx-cli is being installed or removed. Quit every urx and try again.".to_owned(),
            Problem::Maintenance(path) => format!(
                "{} is not what urx-cli maintenance makes, so nothing was changed. Check it, and remove it only if nothing of urx-cli is installed.",
                path.display()
            ),
            Problem::Conflict(path) => format!(
                "{} is not urx-cli's. It was kept, and nothing more was changed.",
                path.display()
            ),
            Problem::Unrecorded(path) => format!(
                "{} has no installation record, so which files are urx-cli's is not known. Nothing was changed.",
                path.display()
            ),
            Problem::Unfinished { release } => format!(
                "An installation or removal of urx-cli {release} did not finish. Finish it with that release's installer, or remove it with urx-uninstall."
            ),
            Problem::Source(why) => format!("The release files cannot be installed ({why}). Nothing was installed."),
            Problem::NotRelease => "This urx-install was not built for a release, so it installs nothing.".to_owned(),
            Problem::Write(path) => format!(
                "{} could not be changed. The installation is incomplete: once the cause is fixed, run the same command again.",
                path.display()
            ),
            Problem::Verify(path) => format!(
                "{} is not what was installed. The installation is incomplete: run the installer again.",
                path.display()
            ),
            Problem::Interrupted => {
                "Interrupted before it finished. The installation is incomplete: run the same command again.".to_owned()
            }
            Problem::Unreachable(path) => format!(
                "Other users cannot pass through {}, so they could not run urx. Let every user search it (mode o+x), then run the installer again.",
                path.display()
            ),
            Problem::Exposed(path) => format!(
                "Users other than root can change {}, so urx-cli is not installed there. Make root its owner and remove group and other write permission from it, then run the installer again.",
                path.display()
            ),
            Problem::RemovalUnfinished { .. } => "The removal did not finish, and the installed urx-uninstall is already removed. Finish it with sudo and --apply from the urx-uninstall on the urx-cli disk image (urx-cli/maintenance/urx-uninstall) or in the recovery ZIP.".to_owned(),
        }
    }

    /// The exit status: 130 for an interruption, 1 otherwise.
    pub fn exit_code(&self) -> i32 {
        if matches!(
            self,
            Problem::Interrupted | Problem::RemovalUnfinished { interrupted: true }
        ) {
            130
        } else {
            1
        }
    }
}

/// What maintenance did or would do, one line each.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
    pub lines: Vec<String>,
}

impl Report {
    pub fn line(&mut self, line: String) {
        self.lines.push(line);
    }
}

/// How a tool was asked to run.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Preview,
    Apply,
    Help,
}

/// The arguments of `urx-install` and `urx-uninstall`: none (a preview),
/// `--apply`, or `--help`. Anything else is None.
pub fn mode_of(arguments: &[std::ffi::OsString]) -> Option<Mode> {
    match arguments {
        [] => Some(Mode::Preview),
        [only] if only == "--apply" => Some(Mode::Apply),
        [only] if only == "--help" || only == "-h" => Some(Mode::Help),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tools_take_no_argument_apply_or_help_only() {
        let of = |arguments: &[&str]| {
            mode_of(
                &arguments
                    .iter()
                    .map(std::ffi::OsString::from)
                    .collect::<Vec<_>>(),
            )
        };
        assert_eq!(of(&[]), Some(Mode::Preview));
        assert_eq!(of(&["--apply"]), Some(Mode::Apply));
        assert_eq!(of(&["--help"]), Some(Mode::Help));
        assert_eq!(of(&["--apply", "--apply"]), None);
        assert_eq!(of(&["--force"]), None);
        assert_eq!(of(&["apply"]), None);
    }
}
