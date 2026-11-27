//! Ctrl+C and termination signals during maintenance: the current operation
//! returns, and nothing more is changed (K41). Nothing is undone.

use std::sync::atomic::{AtomicBool, Ordering};

static REQUESTED: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(_: libc::c_int) {
    REQUESTED.store(true, Ordering::SeqCst);
}

/// Records SIGINT, SIGTERM and SIGHUP instead of ending the process.
pub fn watch() {
    for signal in [libc::SIGINT, libc::SIGTERM, libc::SIGHUP] {
        // SAFETY: the handler only stores to an atomic, which is signal-safe.
        unsafe { libc::signal(signal, on_signal as *const () as libc::sighandler_t) };
    }
}

/// Whether a signal has arrived.
pub fn requested() -> bool {
    REQUESTED.load(Ordering::SeqCst)
}
