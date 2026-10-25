//! Ceiling for the OpenTUI client. The parent measures the child and stops it.
//!
//! A JavaScript heap flag does not cover the native text buffers, and a
//! virtual-memory limit trips on JavaScriptCore's empty guard region.

use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::Duration;

/// Default physical-footprint ceiling for one terminal client.
pub const TERM_MEMORY_MAX_BYTES: u64 = 1024 * 1024 * 1024;

/// `KOMA_TERM_MAX_MB` when it is a positive number of megabytes, otherwise [`TERM_MEMORY_MAX_BYTES`].
pub fn ceiling_from(value: Option<&str>) -> u64 {
    let Some(text) = value else {
        return TERM_MEMORY_MAX_BYTES;
    };
    match text.trim().parse::<u64>() {
        Ok(mb) if mb > 0 => mb.saturating_mul(1024 * 1024),
        _ => TERM_MEMORY_MAX_BYTES,
    }
}

pub fn ceiling_bytes() -> u64 {
    ceiling_from(std::env::var("KOMA_TERM_MAX_MB").ok().as_deref())
}

pub fn over_memory_ceiling(bytes: u64, ceiling: u64) -> bool {
    ceiling > 0 && bytes > ceiling
}

/// Polls `pid` once a second. `finish` stops the poll and reports whether this watch killed it.
pub struct Watch {
    stop: Option<mpsc::Sender<()>>,
    join: Option<JoinHandle<bool>>,
}

impl Watch {
    pub fn start(pid: u32, ceiling: u64) -> Self {
        #[cfg(unix)]
        {
            let (tx, rx) = mpsc::channel();
            let join = thread::spawn(move || watch_unix(pid, ceiling, rx));
            Self {
                stop: Some(tx),
                join: Some(join),
            }
        }
        #[cfg(not(unix))]
        {
            let _ = (pid, ceiling);
            Self {
                stop: None,
                join: None,
            }
        }
    }

    pub fn finish(mut self) -> bool {
        self.stop.take();
        self.join
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or(false)
    }
}

impl Drop for Watch {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
    }
}

#[cfg(unix)]
fn watch_unix(pid: u32, ceiling: u64, stop: Receiver<()>) -> bool {
    let Some(born) = first_charge(pid, &stop) else {
        return false;
    };
    loop {
        match stop.recv_timeout(Duration::from_secs(1)) {
            Err(RecvTimeoutError::Timeout) => {}
            _ => return false,
        }
        let Some(charge) = process_charge(pid) else {
            continue;
        };
        // The pid was reused after the client exited. Leave the new process alone.
        if charge.started != born {
            return false;
        }
        if over_memory_ceiling(charge.bytes, ceiling) {
            kill_group(pid);
            return true;
        }
    }
}

#[cfg(unix)]
fn first_charge(pid: u32, stop: &Receiver<()>) -> Option<u64> {
    loop {
        if let Some(charge) = process_charge(pid) {
            return Some(charge.started);
        }
        match stop.recv_timeout(Duration::from_secs(1)) {
            Err(RecvTimeoutError::Timeout) => {}
            _ => return None,
        }
    }
}

#[cfg(unix)]
fn kill_group(pid: u32) {
    let pid = pid as i32;
    if pid <= 0 {
        return;
    }
    unsafe {
        // The client is spawned as its own process group (`process_group(0)`).
        libc::kill(-pid, libc::SIGKILL);
    }
}

#[cfg(unix)]
struct Charge {
    bytes: u64,
    started: u64,
}

/// Charged bytes and a start token for a live pid.
/// `None` when the pid is gone or this OS has no reader.
#[cfg(unix)]
fn process_charge(pid: u32) -> Option<Charge> {
    #[cfg(target_os = "macos")]
    {
        macos_phys_footprint(pid)
    }
    #[cfg(target_os = "linux")]
    {
        let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        Some(Charge {
            bytes: charged_status_bytes(&status)?,
            started: proc_start_ticks(&stat)?,
        })
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}

/// Resident plus swap from `/proc/<pid>/status`. A missing `VmSwap` is zero.
/// A missing `VmRSS` is not a sample. Headless `koma` does not link `procmem`.
#[cfg(any(target_os = "linux", test))]
fn charged_status_bytes(status: &str) -> Option<u64> {
    let rss = parse_kb_field(status, "VmRSS:")?;
    let swap = parse_kb_field(status, "VmSwap:").unwrap_or(0);
    Some(rss.saturating_add(swap))
}

/// `starttime` from `/proc/<pid>/stat` (field 22). The comm can contain spaces
/// and parentheses, so the count starts after the last `)`.
#[cfg(any(target_os = "linux", test))]
fn proc_start_ticks(stat: &str) -> Option<u64> {
    let rest = stat.rsplit_once(')')?.1;
    rest.split_whitespace().nth(19)?.parse().ok()
}

#[cfg(any(target_os = "linux", test))]
fn parse_kb_field(text: &str, key: &str) -> Option<u64> {
    for line in text.lines() {
        let Some(rest) = line.trim_start().strip_prefix(key) else {
            continue;
        };
        let Some(kb) = rest
            .split_whitespace()
            .next()
            .and_then(|n| n.parse::<u64>().ok())
        else {
            continue;
        };
        return Some(kb.saturating_mul(1024));
    }
    None
}

#[cfg(target_os = "macos")]
fn macos_phys_footprint(pid: u32) -> Option<Charge> {
    // Matches `struct rusage_info_v4` in the macOS SDK. `ri_phys_footprint` is the
    // ledger Activity Monitor and jetsam charge, including compressed pages.
    #[repr(C)]
    #[allow(dead_code)] // The kernel writes every field. Rust reads two of them.
    struct RusageV4 {
        ri_uuid: [u8; 16],
        ri_user_time: u64,
        ri_system_time: u64,
        ri_pkg_idle_wkups: u64,
        ri_interrupt_wkups: u64,
        ri_pageins: u64,
        ri_wired_size: u64,
        ri_resident_size: u64,
        ri_phys_footprint: u64,
        ri_proc_start_abstime: u64,
        ri_proc_exit_abstime: u64,
        ri_child_user_time: u64,
        ri_child_system_time: u64,
        ri_child_pkg_idle_wkups: u64,
        ri_child_interrupt_wkups: u64,
        ri_child_pageins: u64,
        ri_child_elapsed_abstime: u64,
        ri_diskio_bytesread: u64,
        ri_diskio_byteswritten: u64,
        ri_cpu_time_qos_default: u64,
        ri_cpu_time_qos_maintenance: u64,
        ri_cpu_time_qos_background: u64,
        ri_cpu_time_qos_utility: u64,
        ri_cpu_time_qos_legacy: u64,
        ri_cpu_time_qos_user_initiated: u64,
        ri_cpu_time_qos_user_interactive: u64,
        ri_billed_system_time: u64,
        ri_serviced_system_time: u64,
        ri_logical_writes: u64,
        ri_lifetime_max_phys_footprint: u64,
        ri_instructions: u64,
        ri_cycles: u64,
        ri_billed_energy: u64,
        ri_serviced_energy: u64,
        ri_interval_max_phys_footprint: u64,
        ri_runnable_time: u64,
    }
    #[link(name = "proc")]
    extern "C" {
        fn proc_pid_rusage(pid: i32, flavor: i32, buffer: *mut RusageV4) -> i32;
    }
    const RUSAGE_INFO_V4: i32 = 4;
    let mut info: RusageV4 = unsafe { std::mem::zeroed() };
    let rc = unsafe { proc_pid_rusage(pid as i32, RUSAGE_INFO_V4, &mut info) };
    if rc != 0 {
        return None;
    }
    Some(Charge {
        bytes: info.ri_phys_footprint,
        started: info.ri_proc_start_abstime,
    })
}

/// Put the tty back after a hard kill. The client never gets to leave the alt screen.
#[cfg(unix)]
pub fn restore_terminal() {
    unsafe {
        let mut term: libc::termios = std::mem::zeroed();
        if libc::tcgetattr(libc::STDIN_FILENO, &mut term) == 0 {
            term.c_lflag |= libc::ICANON | libc::ECHO;
            libc::tcsetattr(libc::STDIN_FILENO, libc::TCSANOW, &term);
            let previous = libc::getpgrp();
            if previous > 0 {
                libc::tcsetpgrp(libc::STDIN_FILENO, previous);
            }
        }
    }
    let _ = std::io::Write::write_all(&mut std::io::stderr(), b"\x1b[?1049l\x1b[0m\x1b[?25h\r\n");
}

/// Windows commit-charge cap. Held until the client exits so the limit stays armed.
///
/// Crossing the limit fails the next commit and posts
/// `JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT` (9). The watch thread then ends the job,
/// which is what actually stops the process.
#[cfg(windows)]
pub struct TermJob {
    handle: windows_sys::Win32::Foundation::HANDLE,
    port: windows_sys::Win32::Foundation::HANDLE,
    stop: Option<mpsc::Sender<()>>,
    join: Option<JoinHandle<bool>>,
}

#[cfg(windows)]
impl TermJob {
    pub fn arm(process: std::os::windows::io::RawHandle, ceiling: u64) -> Option<Self> {
        use std::io::Error;
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::Foundation::HANDLE;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        };
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                eprintln!(
                    "koma could not cap the terminal: {}",
                    Error::last_os_error()
                );
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.ProcessMemoryLimit = ceiling as usize;
            if SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                eprintln!(
                    "koma could not cap the terminal: {}",
                    Error::last_os_error()
                );
                let _ = CloseHandle(handle);
                return None;
            }
            if AssignProcessToJobObject(handle, process as HANDLE) == 0 {
                eprintln!(
                    "koma could not cap the terminal: {}",
                    Error::last_os_error()
                );
                let _ = CloseHandle(handle);
                return None;
            }
            let (port, stop, join) = watch_job(handle);
            Some(Self {
                handle,
                port,
                stop,
                join,
            })
        }
    }

    /// Stops the watch thread. True when the job hit the ceiling.
    pub fn finish(mut self, ceiling: u64) -> bool {
        self.stop.take();
        let killed = self
            .join
            .take()
            .and_then(|handle| handle.join().ok())
            .unwrap_or(false);
        killed || self.exceeded(ceiling)
    }

    /// True when the job's peak commit reached the ceiling. The kernel fills this
    /// in when it stops the process, including between polls.
    pub fn exceeded(&self, ceiling: u64) -> bool {
        use windows_sys::Win32::System::JobObjects::{
            JobObjectExtendedLimitInformation, QueryInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        };
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            ok != 0 && info.PeakProcessMemoryUsed as u64 >= ceiling && ceiling > 0
        }
    }
}

#[cfg(windows)]
fn watch_job(
    job: windows_sys::Win32::Foundation::HANDLE,
) -> (
    windows_sys::Win32::Foundation::HANDLE,
    Option<mpsc::Sender<()>>,
    Option<JoinHandle<bool>>,
) {
    use std::io::Error;
    use std::sync::mpsc::TryRecvError;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::JobObjects::{
        JobObjectAssociateCompletionPortInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_ASSOCIATE_COMPLETION_PORT,
    };
    use windows_sys::Win32::System::IO::{
        CreateIoCompletionPort, GetQueuedCompletionStatus, OVERLAPPED,
    };
    // winnt.h. A completion port is what turns the commit failure into a message.
    const JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT: u32 = 9;
    unsafe {
        let port = CreateIoCompletionPort(INVALID_HANDLE_VALUE, std::ptr::null_mut(), 0, 1);
        if port.is_null() {
            eprintln!(
                "koma could not watch the terminal cap: {}",
                Error::last_os_error()
            );
            return (std::ptr::null_mut(), None, None);
        }
        let assoc = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
            CompletionKey: std::ptr::null_mut(),
            CompletionPort: port,
        };
        if SetInformationJobObject(
            job,
            JobObjectAssociateCompletionPortInformation,
            &assoc as *const _ as *const _,
            std::mem::size_of::<JOBOBJECT_ASSOCIATE_COMPLETION_PORT>() as u32,
        ) == 0
        {
            eprintln!(
                "koma could not watch the terminal cap: {}",
                Error::last_os_error()
            );
            let _ = CloseHandle(port);
            return (std::ptr::null_mut(), None, None);
        }
        let (tx, rx) = mpsc::channel();
        // HANDLE is a raw pointer, so the thread carries the bits.
        let job_bits = job as usize;
        let port_bits = port as usize;
        let join = thread::spawn(move || {
            let job = job_bits as HANDLE;
            let port = port_bits as HANDLE;
            loop {
                let mut bytes = 0u32;
                let mut key: usize = 0;
                let mut overlapped: *mut OVERLAPPED = std::ptr::null_mut();
                let ok = unsafe {
                    GetQueuedCompletionStatus(port, &mut bytes, &mut key, &mut overlapped, 1000)
                };
                if ok != 0 && bytes == JOB_OBJECT_MSG_PROCESS_MEMORY_LIMIT {
                    unsafe {
                        let _ = TerminateJobObject(job, 1);
                    }
                    return true;
                }
                match rx.try_recv() {
                    Err(TryRecvError::Empty) => {}
                    _ => return false,
                }
            }
        });
        (port, Some(tx), Some(join))
    }
}

#[cfg(windows)]
impl Drop for TermJob {
    fn drop(&mut self) {
        self.stop.take();
        if let Some(handle) = self.join.take() {
            let _ = handle.join();
        }
        unsafe {
            let close = windows_sys::Win32::Foundation::CloseHandle;
            if !self.port.is_null() {
                let _ = close(self.port);
            }
            if !self.handle.is_null() {
                let _ = close(self.handle);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ceiling_keeps_the_default_unless_the_override_is_positive() {
        assert_eq!(ceiling_from(None), TERM_MEMORY_MAX_BYTES);
        assert_eq!(ceiling_from(Some("")), TERM_MEMORY_MAX_BYTES);
        assert_eq!(ceiling_from(Some("0")), TERM_MEMORY_MAX_BYTES);
        assert_eq!(ceiling_from(Some("nope")), TERM_MEMORY_MAX_BYTES);
        assert_eq!(ceiling_from(Some(" 512 ")), 512 * 1024 * 1024);
    }

    #[test]
    fn linux_status_charges_resident_plus_swap() {
        let plain = "VmRSS:\t   1234 kB\n";
        assert_eq!(charged_status_bytes(plain), Some(1234 * 1024));
        let swapped = "VmRSS:\t   1000 kB\nVmSwap:\t   250 kB\n";
        assert_eq!(charged_status_bytes(swapped), Some(1250 * 1024));
        assert_eq!(charged_status_bytes("no rss here"), None);
        assert_eq!(
            proc_start_ticks("12 (koma proc) S 1 12 12 0 0 0 0 0 0 0 1 2 0 0 20 0 1 0 4242"),
            Some(4242)
        );
        assert_eq!(
            proc_start_ticks("12 (weird) name) S 1 12 12 0 0 0 0 0 0 0 1 2 0 0 20 0 1 0 99"),
            Some(99)
        );
        assert_eq!(proc_start_ticks("no comm"), None);
    }

    #[test]
    fn over_ceiling_is_strict() {
        assert!(!over_memory_ceiling(1024, 1024));
        assert!(over_memory_ceiling(1025, 1024));
        assert!(!over_memory_ceiling(u64::MAX, 0));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_process_has_a_live_footprint_under_the_ceiling() {
        let charge = process_charge(std::process::id()).expect("phys_footprint");
        assert!(charge.bytes > 0, "footprint was 0");
        assert!(charge.started > 0, "start time was 0");
        assert!(
            charge.bytes < TERM_MEMORY_MAX_BYTES,
            "footprint {} crossed 1 GiB",
            charge.bytes
        );
    }
}
