//! New terminal. Spawns the OpenTUI client in `src-term`. `koma` opens a new
//! session. `koma agents` and `koma --resume` open the resume hub. The client
//! starts a session daemon only when a session is opened. `koma legacy` is the
//! ratatui client.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use anyhow::{anyhow, Context, Result};

#[cfg(windows)]
const BUN_NAME: &str = "bun.exe";
#[cfg(not(windows))]
const BUN_NAME: &str = "bun";

/// Where the new terminal lands on launch.
pub enum TermStart {
    /// Resume hub. No daemon until a row is opened.
    Hub,
    /// A session. `None` means the client mints a fresh id.
    Session(Option<String>),
}

/// Spawn the OpenTUI preview and wait until it exits.
///
/// The preview owns the terminal. On Unix it is moved into the foreground
/// process group so Ctrl-C reaches OpenTUI, which restores the screen, instead
/// of killing this process mid-frame.
pub fn run_term_preview(start: TermStart) -> Result<()> {
    let term_dir = find_term_dir().ok_or_else(|| {
        anyhow!(
            "the new terminal is not in this build.\n  \
             The current terminal is `koma legacy`."
        )
    })?;
    let bun = find_bun(&term_dir).ok_or_else(|| {
        anyhow!(
            "the new terminal needs bun 1.3.14 or newer on PATH (https://bun.sh).\n  \
             The current terminal is `koma legacy`."
        )
    })?;

    let mut cmd = Command::new(&bun);
    // Absolute entry so the client keeps the user's working directory.
    // A new session is bucketed from that directory, not from src-term.
    cmd.arg(term_dir.join("src/index.tsx"))
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // The client shells out to this binary for `sessions --json` and
    // `--daemon --session`. `current_exe` stays correct if the binary was renamed.
    if let Ok(exe) = std::env::current_exe() {
        cmd.env("KOMA_BIN", exe);
    }
    // Hello.version is this fingerprint. The client restarts a session daemon
    // that was built from an older binary, which would reject ReplaceInput.
    cmd.env("KOMA_BUILD", crate::model::store::build_fingerprint());
    cmd.env("KOMA_VERSION", crate::model::store::current_version());
    match start {
        TermStart::Hub => {
            cmd.env("KOMA_START", "hub");
        }
        TermStart::Session(id) => {
            cmd.env("KOMA_START", "session");
            if let Some(id) = id {
                cmd.env("KOMA_SESSION", id);
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd
        .spawn()
        .with_context(|| format!("failed to start {}", bun.display()))?;

    #[cfg(unix)]
    let _foreground = ForegroundGuard::handoff(child.id());
    // Ctrl+C is delivered to the foreground job. If this parent is still in
    // that group, the default action kills it and the hub vanishes before the
    // client can open the quit screen. Ignore it here; the client handles it.
    #[cfg(unix)]
    let _interrupt = InterruptGuard::ignore();
    // A resize signal often hits this parent, not the client. Forward it so
    // the client sees the real width and can replace the UI under 50 columns.
    #[cfg(unix)]
    let _winch = WinchGuard::forward(child.id());

    let status = child
        .wait()
        .context("the new terminal stopped before it could exit")?;

    match status.code() {
        Some(0) => Ok(()),
        Some(code) => std::process::exit(code),
        None => std::process::exit(1),
    }
}

fn find_term_dir() -> Option<PathBuf> {
    term_dir_candidates()
        .into_iter()
        .find(|dir| dir.join("package.json").is_file())
}

fn term_dir_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Some(dir) = std::env::var_os("KOMA_TERM_DIR") {
        out.push(PathBuf::from(dir));
    }
    if let Ok(exe) = std::env::current_exe() {
        push_src_term(&mut out, exe.parent());
    }
    if let Ok(cwd) = std::env::current_dir() {
        push_src_term(&mut out, Some(cwd.as_path()));
    }
    out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src-term"));
    out
}

fn push_src_term(out: &mut Vec<PathBuf>, mut dir: Option<&Path>) {
    for _ in 0..8 {
        let Some(current) = dir else {
            break;
        };
        out.push(current.join("src-term"));
        dir = current.parent();
    }
}

fn find_bun(term_dir: &Path) -> Option<PathBuf> {
    if let Some(explicit) = std::env::var_os("KOMA_BUN") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Some(path);
        }
    }
    let vendored = term_dir.join(".tools").join(BUN_NAME);
    if vendored.is_file() {
        return Some(vendored);
    }
    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths).find_map(|dir| {
        let candidate = dir.join(BUN_NAME);
        candidate.is_file().then_some(candidate)
    })
}

#[cfg(unix)]
static TERM_CHILD: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

#[cfg(unix)]
extern "C" fn forward_winch(_: libc::c_int) {
    let pid = TERM_CHILD.load(std::sync::atomic::Ordering::Relaxed);
    if pid > 0 {
        unsafe {
            libc::kill(pid, libc::SIGWINCH);
        }
    }
}

/// Forwards SIGWINCH to the terminal client.
#[cfg(unix)]
struct WinchGuard;

#[cfg(unix)]
impl WinchGuard {
    fn forward(pid: u32) -> Self {
        TERM_CHILD.store(pid as i32, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGWINCH, forward_winch as *const () as libc::sighandler_t);
        }
        Self
    }
}

#[cfg(unix)]
impl Drop for WinchGuard {
    fn drop(&mut self) {
        TERM_CHILD.store(0, std::sync::atomic::Ordering::Relaxed);
        unsafe {
            libc::signal(libc::SIGWINCH, libc::SIG_DFL);
        }
    }
}

/// Ignores SIGINT and SIGQUIT in this process while the client is running.
#[cfg(unix)]
struct InterruptGuard;

#[cfg(unix)]
impl InterruptGuard {
    fn ignore() -> Self {
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_IGN);
            libc::signal(libc::SIGQUIT, libc::SIG_IGN);
        }
        Self
    }
}

#[cfg(unix)]
impl Drop for InterruptGuard {
    fn drop(&mut self) {
        unsafe {
            libc::signal(libc::SIGINT, libc::SIG_DFL);
            libc::signal(libc::SIGQUIT, libc::SIG_DFL);
        }
    }
}

/// Puts the preview in the foreground while it runs, then hands the terminal back.
#[cfg(unix)]
struct ForegroundGuard {
    previous: libc::pid_t,
    active: bool,
}

#[cfg(unix)]
impl ForegroundGuard {
    fn handoff(child: u32) -> Self {
        let previous = unsafe { libc::getpgrp() };
        let tty = unsafe { libc::isatty(libc::STDIN_FILENO) } == 1;
        if !tty {
            return Self {
                previous,
                active: false,
            };
        }
        unsafe {
            libc::signal(libc::SIGTTOU, libc::SIG_IGN);
            libc::tcsetpgrp(libc::STDIN_FILENO, child as libc::pid_t);
        }
        Self {
            previous,
            active: true,
        }
    }
}

#[cfg(unix)]
impl Drop for ForegroundGuard {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        unsafe {
            libc::tcsetpgrp(libc::STDIN_FILENO, self.previous);
            libc::signal(libc::SIGTTOU, libc::SIG_DFL);
        }
    }
}
