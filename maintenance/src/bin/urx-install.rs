//! `urx-install` (K41): run from the mounted disk image, it previews by
//! default; `sudo urx-install --apply` installs, updates or repairs urx-cli
//! from the release tree beside it.

#[cfg(target_os = "macos")]
fn main() {
    use urx_maintenance::{interrupt, mode_of, place::Layout, Mode, Problem};
    const USAGE: &str = "usage: urx-install [--apply]\n\nWithout --apply it shows what it would do and changes nothing.\nWith --apply (run with sudo) it installs, updates or repairs urx-cli\nin /usr/local/lib/urx-cli and links /usr/local/bin/urx.\n";
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let mode = match mode_of(&arguments) {
        Some(Mode::Help) => {
            print!("{USAGE}");
            return;
        }
        Some(mode) => mode,
        None => {
            eprint!("urx-install: unknown arguments\n{USAGE}");
            std::process::exit(2);
        }
    };
    interrupt::watch();
    let apply = mode == Mode::Apply;
    let result = (|| {
        // The SHA-256 of the release manifest this installer is built for (K38, K41).
        let expected = option_env!("URX_RELEASE_MANIFEST_SHA256").ok_or(Problem::NotRelease)?;
        if apply && urx_maintenance::sys::effective_user() != 0 {
            return Err(Problem::NotAdministrator);
        }
        let source = std::env::current_exe()
            .and_then(|path| path.canonicalize())
            .ok()
            .and_then(|path| path.parent().map(|folder| folder.join("urx-cli")))
            .ok_or_else(|| Problem::Source("the installer could not locate itself".to_owned()))?;
        urx_maintenance::install::install(
            &Layout::fixed(),
            &source,
            expected,
            apply,
            &interrupt::requested,
        )
    })();
    match result {
        Ok(report) => {
            for line in report.lines {
                println!("{line}");
            }
        }
        Err(problem) => {
            eprintln!("urx-install: {}", problem.message());
            std::process::exit(problem.exit_code());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("urx-install: runs on macOS only");
    std::process::exit(1);
}
