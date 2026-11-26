//! The installation's use protection (K21): a shared hold on the retained,
//! empty `gate.lock`. A maintenance process holds it exclusively, so a busy
//! gate means installation, update or removal is in progress. The hold is
//! taken without waiting, and the launcher never creates or repairs the gate.

use std::path::Path;

/// Why the gate gives no protection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateFailure {
    /// The gate does not exist: the installation was never completed.
    Missing,
    /// Maintenance holds the gate.
    Busy,
    /// The gate exists but is not the retained empty file, or cannot be opened.
    Unusable,
}

#[cfg(unix)]
pub use unix::Gate;
#[cfg(windows)]
pub use windows::Gate;

#[cfg(unix)]
mod unix {
    use super::GateFailure;
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    use std::path::Path;

    /// The open gate with its shared lock. The descriptor is the protection:
    /// it is passed to the runtime across `execve`, never unlocked early.
    #[derive(Debug)]
    pub struct Gate {
        pub(crate) fd: libc::c_int,
    }

    impl Gate {
        /// Opens `path` without following a link, checks that it is an empty
        /// regular file (owned by `owner` when given) and takes a shared lock
        /// without waiting.
        pub fn open(path: &Path, owner: Option<libc::uid_t>) -> Result<Gate, GateFailure> {
            let path =
                CString::new(path.as_os_str().as_bytes()).map_err(|_| GateFailure::Unusable)?;
            // SAFETY: `path` is a valid NUL-terminated string; the flags open read-only.
            let fd = unsafe {
                libc::open(
                    path.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if fd < 0 {
                let error = std::io::Error::last_os_error();
                return Err(match error.raw_os_error() {
                    Some(libc::ENOENT) => GateFailure::Missing,
                    _ => GateFailure::Unusable,
                });
            }
            let gate = Gate { fd };
            // SAFETY: an all-zero `stat` is a valid value for fstat to fill.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: `fd` is open and `stat` is writable.
            if unsafe { libc::fstat(gate.fd, &mut stat) } != 0 {
                return Err(GateFailure::Unusable);
            }
            let regular = stat.st_mode & libc::S_IFMT == libc::S_IFREG;
            if !regular || stat.st_size != 0 || owner.is_some_and(|owner| stat.st_uid != owner) {
                return Err(GateFailure::Unusable);
            }
            // SAFETY: `fd` is open; the lock is shared and does not wait.
            if unsafe { libc::flock(gate.fd, libc::LOCK_SH | libc::LOCK_NB) } != 0 {
                let error = std::io::Error::last_os_error();
                return Err(match error.raw_os_error() {
                    Some(libc::EWOULDBLOCK) => GateFailure::Busy,
                    _ => GateFailure::Unusable,
                });
            }
            Ok(gate)
        }

        /// Keeps the descriptor open across `execve`: the runtime inherits the
        /// same open file, and with it the lock.
        pub fn keep_across_exec(&self) -> std::io::Result<()> {
            // SAFETY: `fd` is open; clearing FD_CLOEXEC changes only this descriptor.
            if unsafe { libc::fcntl(self.fd, libc::F_SETFD, 0) } != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        }
    }

    impl Drop for Gate {
        fn drop(&mut self) {
            // SAFETY: `fd` is owned by this gate and closed once.
            unsafe { libc::close(self.fd) };
        }
    }
}

#[cfg(windows)]
mod windows {
    use super::GateFailure;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
        ERROR_SHARING_VIOLATION, GENERIC_READ, HANDLE, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, OPEN_EXISTING,
    };

    /// The open gate. Opened for reading with read sharing only, it keeps any
    /// exclusive open (maintenance) out while it, or an inherited copy, is open.
    #[derive(Debug)]
    pub struct Gate {
        pub(crate) handle: HANDLE,
    }

    impl Gate {
        /// Opens `path` for reading, sharing reads only, without following a
        /// reparse point, and checks that it is an empty regular file.
        pub fn open(path: &Path, _owner: Option<u32>) -> Result<Gate, GateFailure> {
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            // SAFETY: `wide` is NUL-terminated; no security attributes; no template.
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ,
                    FILE_SHARE_READ,
                    std::ptr::null(),
                    OPEN_EXISTING,
                    FILE_FLAG_OPEN_REPARSE_POINT,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                // SAFETY: reads the calling thread's last error.
                return Err(match unsafe { GetLastError() } {
                    ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => GateFailure::Missing,
                    ERROR_SHARING_VIOLATION => GateFailure::Busy,
                    _ => GateFailure::Unusable,
                });
            }
            let gate = Gate { handle };
            // SAFETY: an all-zero information record is valid for the call to fill.
            let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
            // SAFETY: `handle` is open and `info` is writable.
            if unsafe { GetFileInformationByHandle(gate.handle, &mut info) } == 0 {
                return Err(GateFailure::Unusable);
            }
            let special = info.dwFileAttributes
                & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)
                != 0;
            if special || info.nFileSizeHigh != 0 || info.nFileSizeLow != 0 {
                return Err(GateFailure::Unusable);
            }
            Ok(gate)
        }
    }

    impl Drop for Gate {
        fn drop(&mut self) {
            // SAFETY: `handle` is owned by this gate and closed once.
            unsafe { CloseHandle(self.handle) };
        }
    }
}

/// The gate file inside the maintenance directory.
pub fn gate_path(maintenance: &Path) -> std::path::PathBuf {
    maintenance.join("gate.lock")
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::symlink;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("urx-launcher-gate-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn an_empty_file_gives_a_shared_hold_that_another_shared_hold_does_not_block() {
        let dir = scratch("shared");
        let path = dir.join("gate.lock");
        fs::write(&path, b"").unwrap();
        let first = Gate::open(&path, None).unwrap();
        let second = Gate::open(&path, None).unwrap();
        drop((first, second));
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_exclusive_holder_makes_the_gate_busy() {
        let dir = scratch("busy");
        let path = dir.join("gate.lock");
        fs::write(&path, b"").unwrap();
        let maintenance = fs::File::open(&path).unwrap();
        use std::os::unix::io::AsRawFd;
        // SAFETY: the descriptor is open for the test's lifetime.
        assert_eq!(
            unsafe { libc::flock(maintenance.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) },
            0
        );
        assert_eq!(Gate::open(&path, None).unwrap_err(), GateFailure::Busy);
        drop(maintenance);
        assert!(Gate::open(&path, None).is_ok());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_gate_is_missing_and_anything_else_is_unusable() {
        let dir = scratch("unusable");
        assert_eq!(
            Gate::open(&dir.join("gate.lock"), None).unwrap_err(),
            GateFailure::Missing
        );
        let full = dir.join("full.lock");
        fs::write(&full, b"x").unwrap();
        assert_eq!(Gate::open(&full, None).unwrap_err(), GateFailure::Unusable);
        let empty = dir.join("empty.lock");
        fs::write(&empty, b"").unwrap();
        let link = dir.join("link.lock");
        symlink(&empty, &link).unwrap();
        assert_eq!(Gate::open(&link, None).unwrap_err(), GateFailure::Unusable);
        assert_eq!(Gate::open(&dir, None).unwrap_err(), GateFailure::Unusable);
        // SAFETY: getuid has no preconditions.
        let me = unsafe { libc::getuid() };
        assert!(Gate::open(&empty, Some(me)).is_ok());
        assert_eq!(
            Gate::open(&empty, Some(me.wrapping_add(1))).unwrap_err(),
            GateFailure::Unusable
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
