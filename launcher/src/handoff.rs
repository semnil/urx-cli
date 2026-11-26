//! Starting the bundled Node with the CLI's entry script and the user's
//! arguments, unchanged (K22). On macOS the launcher becomes Node through
//! `execve`, keeping the gate's descriptor; on Windows it starts Node as a
//! child that inherits the gate and the standard handles only, waits, and
//! exits with its code. No shell, relay or second window is involved.

use std::ffi::OsString;
use std::path::Path;

/// One argument as the Microsoft C runtime reads it back from a command line:
/// quoted when empty or holding a space, tab or quote, with the backslashes
/// before a quote, and those ending a quoted argument, doubled.
pub fn quote_windows(argument: &[u16]) -> Vec<u16> {
    const QUOTE: u16 = b'"' as u16;
    const BACKSLASH: u16 = b'\\' as u16;
    let needs_quotes = argument.is_empty()
        || argument
            .iter()
            .any(|&unit| unit == b' ' as u16 || unit == b'\t' as u16 || unit == QUOTE);
    if !needs_quotes {
        return argument.to_vec();
    }
    let mut quoted = vec![QUOTE];
    let mut backslashes = 0;
    for &unit in argument {
        if unit == BACKSLASH {
            backslashes += 1;
            continue;
        }
        if unit == QUOTE {
            // Each backslash before a quote is doubled, and the quote escaped.
            quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2 + 1));
        } else {
            quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes));
        }
        backslashes = 0;
        quoted.push(unit);
    }
    // Backslashes before the closing quote are doubled.
    quoted.extend(std::iter::repeat_n(BACKSLASH, backslashes * 2));
    quoted.push(QUOTE);
    quoted
}

/// What the runtime is started with.
pub struct Start<'a> {
    pub runtime: &'a Path,
    pub entry: &'a Path,
    pub arguments: Vec<OsString>,
    pub environment: Vec<(OsString, OsString)>,
}

#[cfg(unix)]
pub use unix::hand_off;
#[cfg(windows)]
pub use windows::hand_off;

#[cfg(unix)]
mod unix {
    use super::Start;
    use crate::gate::Gate;
    use std::ffi::{CString, OsStr};
    use std::os::unix::ffi::OsStrExt;

    fn c_string(value: &OsStr) -> std::io::Result<CString> {
        CString::new(value.as_bytes())
            .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))
    }

    /// Replaces this process with the runtime. Returns only when `execve`
    /// fails; the gate then still holds its lock until it is dropped.
    pub fn hand_off(gate: &Gate, start: Start<'_>) -> std::io::Error {
        let program = match c_string(start.runtime.as_os_str()) {
            Ok(program) => program,
            Err(error) => return error,
        };
        let mut argv = vec![program.clone()];
        for value in std::iter::once(start.entry.as_os_str().to_os_string()).chain(start.arguments)
        {
            match c_string(&value) {
                Ok(value) => argv.push(value),
                Err(error) => return error,
            }
        }
        let mut envp = Vec::new();
        for (name, value) in start.environment {
            let mut entry = name;
            entry.push("=");
            entry.push(value);
            match c_string(&entry) {
                Ok(entry) => envp.push(entry),
                Err(error) => return error,
            }
        }
        if let Err(error) = gate.keep_across_exec() {
            return error;
        }
        let argv_ptrs: Vec<*const libc::c_char> = argv
            .iter()
            .map(|value| value.as_ptr())
            .chain(std::iter::once(std::ptr::null()))
            .collect();
        let envp_ptrs: Vec<*const libc::c_char> = envp
            .iter()
            .map(|value| value.as_ptr())
            .chain(std::iter::once(std::ptr::null()))
            .collect();
        // SAFETY: every pointer refers to a NUL-terminated string kept alive
        // above, and both arrays end with a null pointer.
        unsafe { libc::execve(program.as_ptr(), argv_ptrs.as_ptr(), envp_ptrs.as_ptr()) };
        std::io::Error::last_os_error()
    }
}

#[cfg(windows)]
mod windows {
    use super::{quote_windows, Start};
    use crate::gate::Gate;
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        CloseHandle, SetHandleInformation, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
    };
    use windows_sys::Win32::System::Console::{
        GetStdHandle, SetConsoleCtrlHandler, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
    };
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess,
        InitializeProcThreadAttributeList, UpdateProcThreadAttribute, WaitForSingleObject,
        CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
        LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
        STARTF_USESTDHANDLES, STARTUPINFOEXW,
    };

    fn wide(value: &std::ffi::OsStr) -> Vec<u16> {
        value.encode_wide().collect()
    }

    /// Starts the runtime as a child that inherits only the gate and the
    /// standard handles, waits for it and returns its exit code. Ctrl+C
    /// reaches the child through the shared console; the launcher ignores it.
    pub fn hand_off(gate: &Gate, start: Start<'_>) -> Result<u32, std::io::Error> {
        let mut command = quote_windows(&wide(start.runtime.as_os_str()));
        for value in std::iter::once(start.entry.as_os_str().to_os_string()).chain(start.arguments)
        {
            command.push(b' ' as u16);
            command.extend(quote_windows(&wide(&value)));
        }
        command.push(0);
        let mut environment: Vec<u16> = Vec::new();
        for (name, value) in &start.environment {
            environment.extend(name.encode_wide());
            environment.push(b'=' as u16);
            environment.extend(value.encode_wide());
            environment.push(0);
        }
        environment.push(0);
        if start.environment.is_empty() {
            environment.push(0);
        }
        let application: Vec<u16> = wide(start.runtime.as_os_str())
            .into_iter()
            .chain(std::iter::once(0))
            .collect();

        // The handles the child inherits: the gate, then the standard handles that exist.
        let mut handles: Vec<HANDLE> = vec![gate.handle];
        // SAFETY: GetStdHandle has no preconditions.
        let standard: Vec<HANDLE> = [STD_INPUT_HANDLE, STD_OUTPUT_HANDLE, STD_ERROR_HANDLE]
            .iter()
            .map(|&which| unsafe { GetStdHandle(which) })
            .collect();
        for &handle in &standard {
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE && !handles.contains(&handle) {
                handles.push(handle);
            }
        }
        for &handle in &handles {
            // SAFETY: each handle is open in this process.
            if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) }
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }

        let mut size = 0usize;
        // SAFETY: the first call only reports the size the list needs.
        unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut size) };
        let mut buffer = vec![0u8; size];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: `buffer` has the size the first call reported.
        if unsafe { InitializeProcThreadAttributeList(list, 1, 0, &mut size) } == 0 {
            return Err(std::io::Error::last_os_error());
        }
        // SAFETY: `handles` outlives the list's use in CreateProcessW below.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr() as *const core::ffi::c_void,
                std::mem::size_of_val(handles.as_slice()),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        if updated == 0 {
            let error = std::io::Error::last_os_error();
            // SAFETY: the list was initialized above.
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(error);
        }

        // SAFETY: an all-zero STARTUPINFOEXW is valid before its fields are set.
        let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        info.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        info.StartupInfo.hStdInput = standard[0];
        info.StartupInfo.hStdOutput = standard[1];
        info.StartupInfo.hStdError = standard[2];
        info.lpAttributeList = list;
        // SAFETY: an all-zero PROCESS_INFORMATION is valid for the call to fill.
        let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
        // The launcher leaves Ctrl+C to the child, which shares its console.
        // SAFETY: a null handler with TRUE makes this process ignore Ctrl+C.
        unsafe { SetConsoleCtrlHandler(None, 1) };
        // SAFETY: every string is NUL-terminated and alive for the call; the
        // attribute list and the handles it names are alive too.
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command.as_mut_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                1,
                EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
                environment.as_ptr() as *const core::ffi::c_void,
                std::ptr::null(),
                &info.StartupInfo,
                &mut process,
            )
        };
        let error = std::io::Error::last_os_error();
        // SAFETY: the list was initialized above and is no longer needed.
        unsafe { DeleteProcThreadAttributeList(list) };
        if created == 0 {
            return Err(error);
        }
        // SAFETY: `process` holds the child's handles.
        unsafe {
            CloseHandle(process.hThread);
            WaitForSingleObject(process.hProcess, INFINITE);
        }
        let mut code = 1u32;
        // SAFETY: the process handle is open; `code` is writable.
        let read = unsafe { GetExitCodeProcess(process.hProcess, &mut code) };
        // SAFETY: the process handle is owned here and closed once.
        unsafe { CloseHandle(process.hProcess) };
        if read == 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(code)
    }
}

#[cfg(test)]
mod tests {
    use super::quote_windows;

    fn quote(text: &str) -> String {
        String::from_utf16(&quote_windows(&text.encode_utf16().collect::<Vec<_>>())).unwrap()
    }

    #[test]
    fn an_argument_is_quoted_so_the_c_runtime_reads_it_back_unchanged() {
        assert_eq!(quote("plain"), "plain");
        assert_eq!(quote(""), "\"\"");
        assert_eq!(quote("two words"), "\"two words\"");
        assert_eq!(quote("tab\there"), "\"tab\there\"");
        assert_eq!(quote("say \"hi\""), "\"say \\\"hi\\\"\"");
        assert_eq!(quote(r"C:\path\"), r"C:\path\");
        assert_eq!(quote(r"C:\my path\"), r#""C:\my path\\""#);
        assert_eq!(quote(r#"a\"b"#), r#""a\\\"b""#);
        assert_eq!(quote("--value=-6"), "--value=-6");
        assert_eq!(quote("名前 テスト"), "\"名前 テスト\"");
    }
}
