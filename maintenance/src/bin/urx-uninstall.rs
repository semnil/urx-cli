//! `urx-uninstall` (K20): installed as
//! `/usr/local/lib/urx-cli/maintenance/urx-uninstall` and published in the
//! recovery ZIP, it previews by default; `sudo urx-uninstall --apply` removes
//! what the installation owns and keeps everything else.

#[cfg(target_os = "macos")]
fn main() {
    use urx_maintenance::{interrupt, mode_of, place::Layout, Mode, Problem};
    const USAGE: &str = "usage: urx-uninstall [--apply]\n\nWithout --apply it shows what it would remove and changes nothing.\nWith --apply (run with sudo) it removes urx-cli from /usr/local/lib/urx-cli\nand the /usr/local/bin/urx link, keeping files it did not install.\n";
    let arguments: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let mode = match mode_of(&arguments) {
        Some(Mode::Help) => {
            print!("{USAGE}");
            return;
        }
        Some(mode) => mode,
        None => {
            eprint!("urx-uninstall: unknown arguments\n{USAGE}");
            std::process::exit(2);
        }
    };
    interrupt::watch();
    let apply = mode == Mode::Apply;
    let result = if apply && urx_maintenance::sys::effective_user() != 0 {
        Err(Problem::NotAdministrator)
    } else {
        urx_maintenance::remove::uninstall(&Layout::fixed(), apply, &interrupt::requested)
    };
    match result {
        Ok(report) => {
            for line in report.lines {
                println!("{line}");
            }
        }
        Err(problem) => {
            eprintln!("urx-uninstall: {}", problem.message());
            std::process::exit(problem.exit_code());
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("urx-uninstall: runs on macOS only");
    std::process::exit(1);
}
