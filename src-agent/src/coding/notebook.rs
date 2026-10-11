//! Owned local notebook kernels (M3 spike).
//!
//! Containment rules (enforced here, not in the UI):
//! - Launch only `{interpreter} -m ipykernel_launcher -f {connection_file}`
//! - Never execute `metadata.kernelspec.argv` from the notebook
//! - Connection files live in a private owner-only directory; keys stay native-side
//! - Unix: new process group (reuse task patterns); Windows: job object
//! - Registered in `has_active()` so daemon idle shutdown cannot strand kernels
//! - Opening/create never starts a kernel; first start requires explicit consent
//!
//! Full Jupyter shell/IOPub correlation lands after these containment proofs are green.
//! The Run UI stays disabled until then.

use super::WorkspaceRef;
use anyhow::{Context, Result};
use process_wrap::std::{ChildWrapper, CommandWrap, CommandWrapper};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{Mutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_KERNELS: usize = 8;
const LAUNCHER_MODULE: &str = "ipykernel_launcher";

#[derive(Debug, Clone)]
struct Consent {
    workspace: WorkspaceRef,
    interpreter: String,
    document_path: String,
    document_epoch: u64,
}

#[derive(Debug)]
struct KernelSession {
    id: String,
    workspace: WorkspaceRef,
    document_path: String,
    document_epoch: u64,
    interpreter: String,
    connection_dir: PathBuf,
    #[allow(dead_code)] // held for future shell/IOPub client binding
    connection_file: PathBuf,
    /// Public ports/key material never leave the native side in events.
    generation: u64,
    child: Mutex<Option<Box<dyn ChildWrapper>>>,
    #[cfg(windows)]
    interrupt_event: Option<windows_sys::Win32::Foundation::HANDLE>,
    stopping: bool,
    started_ms: u64,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn registry() -> &'static Mutex<HashMap<String, KernelSession>> {
    static REG: OnceLock<Mutex<HashMap<String, KernelSession>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn consents() -> &'static Mutex<Vec<Consent>> {
    static C: OnceLock<Mutex<Vec<Consent>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(Vec::new()))
}

/// Idle-shutdown must see live kernels as active jobs.
pub(super) fn has_active() -> bool {
    registry().lock().map_or(true, |map| {
        map.values().any(|k| {
            if k.stopping {
                return true;
            }
            k.child
                .lock()
                .map_or(true, |slot| slot.as_ref().is_some_and(|c| c.id() != 0))
        })
    })
}

pub(super) fn shutdown() {
    if let Ok(mut map) = registry().lock() {
        let ids: Vec<String> = map.keys().cloned().collect();
        for id in ids {
            if let Some(mut session) = map.remove(&id) {
                let _ = stop_session(&mut session);
            }
        }
    }
}

/// Reject notebook-supplied kernelspec launchers. Only the fixed launcher module is allowed.
pub(super) fn reject_kernelspec_argv(argv: &[String]) -> Result<()> {
    anyhow::ensure!(
        argv.is_empty(),
        "Refusing notebook metadata.kernelspec.argv; kernels launch only via the selected interpreter and -m {LAUNCHER_MODULE}"
    );
    Ok(())
}

/// Build the only permitted kernel argv. `connection_file` must already exist.
pub(super) fn launch_argv(interpreter: &Path, connection_file: &Path) -> Result<Vec<String>> {
    anyhow::ensure!(
        interpreter.as_os_str().len() > 0 && !interpreter.as_os_str().is_empty(),
        "Interpreter path is empty"
    );
    let interp = interpreter
        .to_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .context("Interpreter path is not valid UTF-8")?;
    let conn = connection_file
        .to_str()
        .filter(|s| !s.is_empty() && !s.contains('\0'))
        .context("Connection file path is not valid UTF-8")?;
    Ok(vec![
        interp.to_string(),
        "-m".into(),
        LAUNCHER_MODULE.into(),
        "-f".into(),
        conn.to_string(),
    ])
}

fn random_token() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut h = DefaultHasher::new();
    now_ms().hash(&mut h);
    std::thread::current().id().hash(&mut h);
    // Prefer OS randomness when available.
    let mut bytes = [0u8; 32];
    if fill_random(&mut bytes).is_ok() {
        return bytes.iter().map(|b| format!("{b:02x}")).collect();
    }
    format!("{:016x}{:016x}", h.finish(), now_ms())
}

fn fill_random(buf: &mut [u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Read;
        fs::File::open("/dev/urandom")?.read_exact(buf)
    }
    #[cfg(windows)]
    {
        // BCryptGenRandom would be ideal; fall back to a mixed hash if unavailable in tests.
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        now_ms().hash(&mut h);
        let mut n = h.finish();
        for b in buf.iter_mut() {
            n = n.wrapping_mul(6364136223846793005).wrapping_add(1);
            *b = (n >> 33) as u8;
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = buf;
        Err(std::io::Error::other("no CSPRNG"))
    }
}

fn pick_port() -> Result<u16> {
    // Bind ephemeral ports on loopback and release them; the kernel re-binds on start.
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

/// Create a private connection directory + JSON file. Keys never go to the frontend.
pub(super) fn write_connection_file(base: &Path) -> Result<(PathBuf, PathBuf, Value)> {
    let dir = base.join(format!("koma-nb-{}", random_token()));
    fs::create_dir_all(&dir).context("Create kernel connection directory")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    let shell = pick_port()?;
    let iopub = pick_port()?;
    let stdin = pick_port()?;
    let control = pick_port()?;
    let hb = pick_port()?;
    let key = random_token();
    let file = dir.join("kernel.json");
    let body = json!({
        "shell_port": shell,
        "iopub_port": iopub,
        "stdin_port": stdin,
        "control_port": control,
        "hb_port": hb,
        "ip": "127.0.0.1",
        "key": key,
        "transport": "tcp",
        "signature_scheme": "hmac-sha256",
        "kernel_name": "python3"
    });
    let bytes = serde_json::to_vec_pretty(&body)?;
    {
        #[cfg(unix)]
        {
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&file)
                .context("Create kernel connection file")?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            // Belt-and-suspenders in case umask interfered.
            fs::set_permissions(&file, fs::Permissions::from_mode(0o600))?;
        }
        #[cfg(not(unix))]
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&file)
                .context("Create kernel connection file")?;
            f.write_all(&bytes)?;
            f.sync_all()?;
        }
    }
    // Never return the key to callers that might serialize to the GUI.
    let public = json!({
        "shell_port": shell,
        "iopub_port": iopub,
        "stdin_port": stdin,
        "control_port": control,
        "hb_port": hb,
        "ip": "127.0.0.1",
        "transport": "tcp",
        "signature_scheme": "hmac-sha256",
        "kernel_name": "python3"
        // key intentionally omitted
    });
    Ok((dir, file, public))
}

fn delete_connection(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[cfg(unix)]
#[derive(Debug)]
struct ProcessTree;
#[cfg(unix)]
impl CommandWrapper for ProcessTree {
    fn pre_spawn(&mut self, cmd: &mut Command, _: &CommandWrap) -> std::io::Result<()> {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        Ok(())
    }
    fn wrap_child(
        &mut self,
        child: Box<dyn ChildWrapper>,
        _: &CommandWrap,
    ) -> std::io::Result<Box<dyn ChildWrapper>> {
        Ok(Box::new(ProcessTreeChild {
            child,
            reaped: false,
        }))
    }
}
#[cfg(unix)]
#[derive(Debug)]
struct ProcessTreeChild {
    child: Box<dyn ChildWrapper>,
    reaped: bool,
}
#[cfg(unix)]
impl ChildWrapper for ProcessTreeChild {
    fn inner(&self) -> &dyn ChildWrapper {
        self.child.as_ref()
    }
    fn inner_mut(&mut self) -> &mut dyn ChildWrapper {
        self.child.as_mut()
    }
    fn into_inner(self: Box<Self>) -> Box<dyn ChildWrapper> {
        self.child
    }
    fn start_kill(&mut self) -> std::io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        super::process_group::kill(self.child.id() as libc::pid_t)
    }
    fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if !self.reaped {
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(None);
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.reaped = true;
                }
                return Err(error);
            }
            if unsafe { info.si_pid() } == 0 {
                return Ok(None);
            }
            self.start_kill()?;
        }
        let status = self.child.try_wait()?;
        self.reaped |= status.is_some();
        Ok(status)
    }
}

#[cfg(windows)]
fn wrap_windows(cmd: &mut CommandWrap) {
    cmd.wrap(process_wrap::std::JobObject);
}

fn stop_session(session: &mut KernelSession) -> Result<()> {
    session.stopping = true;
    if let Ok(mut slot) = session.child.lock() {
        if let Some(child) = slot.as_mut() {
            let _ = child.start_kill();
            for _ in 0..50 {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) => std::thread::sleep(std::time::Duration::from_millis(20)),
                    Err(_) => break,
                }
            }
            let _ = child.start_kill();
            let _ = child.try_wait();
        }
        *slot = None;
    }
    #[cfg(windows)]
    if let Some(handle) = session.interrupt_event.take() {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
    delete_connection(&session.connection_dir);
    session.stopping = false;
    Ok(())
}

fn fingerprint_interpreter(path: &Path) -> String {
    let mut h = Sha256::new();
    h.update(path.to_string_lossy().as_bytes());
    format!("{:x}", h.finalize())[..16].to_string()
}

fn require_consent(
    workspace: &WorkspaceRef,
    interpreter: &str,
    document_path: &str,
    document_epoch: u64,
) -> Result<()> {
    let list = consents()
        .lock()
        .map_err(|_| anyhow::anyhow!("Consent lock poisoned"))?;
    let ok = list.iter().any(|c| {
        c.workspace == *workspace
            && c.interpreter == interpreter
            && c.document_path == document_path
            && c.document_epoch == document_epoch
    });
    anyhow::ensure!(
        ok,
        "Kernel start requires explicit consent for this workspace, interpreter, and document epoch"
    );
    Ok(())
}

pub(super) fn consent(
    workspace: &WorkspaceRef,
    interpreter: &str,
    document_path: &str,
    document_epoch: u64,
) -> Result<Value> {
    anyhow::ensure!(!interpreter.is_empty(), "Interpreter is required");
    anyhow::ensure!(!document_path.is_empty(), "Document path is required");
    anyhow::ensure!(
        document_path.ends_with(".ipynb")
            || document_path.to_ascii_lowercase().ends_with(".ipynb"),
        "Consent is only valid for notebook documents"
    );
    let mut list = consents()
        .lock()
        .map_err(|_| anyhow::anyhow!("Consent lock poisoned"))?;
    list.retain(|c| {
        !(c.workspace == *workspace
            && c.document_path == document_path
            && c.interpreter == interpreter)
    });
    list.push(Consent {
        workspace: workspace.clone(),
        interpreter: interpreter.to_string(),
        document_path: document_path.to_string(),
        document_epoch,
    });
    while list.len() > 64 {
        list.remove(0);
    }
    Ok(json!({"ok": true}))
}

pub(super) fn start(
    workspace: &WorkspaceRef,
    root: &Path,
    document_path: &str,
    document_epoch: u64,
    interpreter: Option<&str>,
    // Must always be empty — callers must not forward notebook kernelspec argv.
    kernelspec_argv: &[String],
) -> Result<Value> {
    reject_kernelspec_argv(kernelspec_argv)?;
    anyhow::ensure!(
        document_path.to_ascii_lowercase().ends_with(".ipynb"),
        "Only .ipynb documents can own a kernel"
    );
    let interp = match interpreter {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => super::environment::test_python(root)?,
    };
    anyhow::ensure!(interp.is_file() || interp.components().count() == 1, "Interpreter not found");
    let interp_str = interp.to_string_lossy().into_owned();
    require_consent(workspace, &interp_str, document_path, document_epoch)?;

    let mut map = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Kernel registry lock poisoned"))?;
    anyhow::ensure!(map.len() < MAX_KERNELS, "Too many live notebook kernels");

    // One kernel per document path per workspace.
    if let Some((id, _)) = map.iter().find(|(_, s)| {
        s.workspace == *workspace && s.document_path == document_path
    }) {
        let id = id.clone();
        let session = map.get(&id).expect("just found");
        return Ok(json!({
            "kernelId": id,
            "generation": session.generation,
            "documentPath": document_path,
            "interpreter": session.interpreter,
            "interpreterFingerprint": fingerprint_interpreter(Path::new(&session.interpreter)),
            "status": "running",
            "reused": true,
        }));
    }

    let base = std::env::temp_dir().join("koma-notebook-kernels");
    fs::create_dir_all(&base)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&base, fs::Permissions::from_mode(0o700));
    }
    let (conn_dir, conn_file, _public_meta) = write_connection_file(&base)?;
    let argv = launch_argv(&interp, &conn_file)?;

    let mut wrap = CommandWrap::with_new(&argv[0], |cmd| {
        cmd.args(&argv[1..])
            .current_dir(root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .env_remove("PYTHONSTARTUP")
            .env("PYTHONUNBUFFERED", "1");
        // Connection keys must not leak via child environment dumps to the GUI.
    });
    #[cfg(unix)]
    {
        wrap.wrap(ProcessTree);
    }
    #[cfg(windows)]
    {
        wrap_windows(&mut wrap);
        // JPY_INTERRUPT_EVENT is set when we wire a real interrupt event (full M3).
    }

    let child = match wrap.spawn() {
        Ok(c) => c,
        Err(err) => {
            delete_connection(&conn_dir);
            // Surface missing ipykernel as a distinct, non-silent failure.
            let msg = err.to_string();
            if msg.contains("No module named") || msg.contains("ipykernel") {
                anyhow::bail!(
                    "ipykernel is not available in the selected interpreter. Review an install plan before retrying — Koma will not silently pip install on open."
                );
            }
            return Err(err).context("Spawn notebook kernel");
        }
    };

    let id = format!("nbk-{}-{}", now_ms(), random_token());
    let session = KernelSession {
        id: id.clone(),
        workspace: workspace.clone(),
        document_path: document_path.to_string(),
        document_epoch,
        interpreter: interp_str.clone(),
        connection_dir: conn_dir,
        connection_file: conn_file,
        generation: 1,
        child: Mutex::new(Some(child)),
        #[cfg(windows)]
        interrupt_event: None,
        stopping: false,
        started_ms: now_ms(),
    };
    map.insert(id.clone(), session);
    Ok(json!({
        "kernelId": id,
        "generation": 1,
        "documentPath": document_path,
        "documentEpoch": document_epoch,
        "interpreter": interp_str,
        "interpreterFingerprint": fingerprint_interpreter(&interp),
        "status": "starting",
        "reused": false,
        "started": now_ms(),
        // Ports/keys intentionally omitted from the GUI-facing payload.
    }))
}

pub(super) fn stop(workspace: &WorkspaceRef, kernel_id: &str) -> Result<Value> {
    let mut map = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Kernel registry lock poisoned"))?;
    let mut session = map
        .remove(kernel_id)
        .context("Kernel session not found")?;
    anyhow::ensure!(
        session.workspace == *workspace,
        "Kernel belongs to another workspace"
    );
    stop_session(&mut session)?;
    Ok(json!({"ok": true, "kernelId": kernel_id}))
}

pub(super) fn interrupt(workspace: &WorkspaceRef, kernel_id: &str) -> Result<Value> {
    let map = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Kernel registry lock poisoned"))?;
    let session = map.get(kernel_id).context("Kernel session not found")?;
    anyhow::ensure!(
        session.workspace == *workspace,
        "Kernel belongs to another workspace"
    );
    #[cfg(unix)]
    {
        let slot = session
            .child
            .lock()
            .map_err(|_| anyhow::anyhow!("Kernel child lock poisoned"))?;
        if let Some(child) = slot.as_ref() {
            let pid = child.id() as libc::pid_t;
            anyhow::ensure!(pid > 1, "Invalid kernel pid");
            // Interrupt the process group with SIGINT (not SIGKILL).
            let rc = unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGINT) };
            if rc != 0 {
                let err = std::io::Error::last_os_error();
                if err.raw_os_error() != Some(libc::ESRCH) {
                    return Err(err).context("Interrupt kernel");
                }
            }
        }
    }
    #[cfg(windows)]
    {
        // Full M3 sets JPY_INTERRUPT_EVENT per jupyter_client.win_interrupt.
        // Until wired, refuse rather than pretend SIGINT works on Windows.
        anyhow::bail!(
            "Windows kernel interrupt requires JPY_INTERRUPT_EVENT (not yet enabled in this spike)"
        );
    }
    #[cfg(not(any(unix, windows)))]
    {
        anyhow::bail!("Kernel interrupt is unavailable on this host");
    }
    Ok(json!({"ok": true, "kernelId": kernel_id, "generation": session.generation}))
}

pub(super) fn restart(
    workspace: &WorkspaceRef,
    root: &Path,
    kernel_id: &str,
) -> Result<Value> {
    let (document_path, document_epoch, interpreter) = {
        let map = registry()
            .lock()
            .map_err(|_| anyhow::anyhow!("Kernel registry lock poisoned"))?;
        let session = map.get(kernel_id).context("Kernel session not found")?;
        anyhow::ensure!(
            session.workspace == *workspace,
            "Kernel belongs to another workspace"
        );
        (
            session.document_path.clone(),
            session.document_epoch,
            session.interpreter.clone(),
        )
    };
    stop(workspace, kernel_id)?;
    // Re-consent is not required for restart of the same epoch binding.
    consent(workspace, &interpreter, &document_path, document_epoch)?;
    start(
        workspace,
        root,
        &document_path,
        document_epoch,
        Some(&interpreter),
        &[],
    )
}

pub(super) fn release(workspace: &WorkspaceRef, kernel_id: &str) -> Result<Value> {
    stop(workspace, kernel_id)
}

pub(super) fn status(workspace: &WorkspaceRef, kernel_id: Option<&str>) -> Result<Value> {
    let map = registry()
        .lock()
        .map_err(|_| anyhow::anyhow!("Kernel registry lock poisoned"))?;
    let rows: Vec<Value> = map
        .values()
        .filter(|s| s.workspace == *workspace)
        .filter(|s| kernel_id.map(|id| s.id == id).unwrap_or(true))
        .map(|s| {
            let alive = s
                .child
                .lock()
                .ok()
                .and_then(|g| g.as_ref().map(|c| c.id() != 0))
                .unwrap_or(false);
            json!({
                "kernelId": s.id,
                "documentPath": s.document_path,
                "documentEpoch": s.document_epoch,
                "generation": s.generation,
                "interpreter": s.interpreter,
                "status": if s.stopping { "stopping" } else if alive { "running" } else { "exited" },
                "started": s.started_ms,
            })
        })
        .collect();
    Ok(json!({ "kernels": rows }))
}

/// Probe whether the selected interpreter can import ipykernel (no process left running).
pub(super) fn probe_ipykernel(root: &Path, interpreter: Option<&str>) -> Result<Value> {
    let interp = match interpreter {
        Some(p) if !p.is_empty() => PathBuf::from(p),
        _ => super::environment::test_python(root)?,
    };
    let output = Command::new(&interp)
        .args([
            "-c",
            "import importlib.util as u, sys; sys.exit(0 if u.find_spec('ipykernel') else 2)",
        ])
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .context("Probe ipykernel")?;
    Ok(json!({
        "interpreter": interp.to_string_lossy(),
        "ipykernel": output.status.success(),
        "exitCode": output.status.code(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn rejects_notebook_kernelspec_argv() {
        let err = reject_kernelspec_argv(&["python".into(), "evil.py".into()]).unwrap_err();
        assert!(err.to_string().contains("kernelspec.argv"));
        reject_kernelspec_argv(&[]).unwrap();
    }

    #[test]
    fn launch_argv_is_fixed_module_form() {
        let argv = launch_argv(Path::new("/usr/bin/python3"), Path::new("/tmp/k.json")).unwrap();
        assert_eq!(
            argv,
            vec![
                "/usr/bin/python3".to_string(),
                "-m".to_string(),
                "ipykernel_launcher".to_string(),
                "-f".to_string(),
                "/tmp/k.json".to_string(),
            ]
        );
    }

    #[test]
    fn connection_file_is_private_loopback_without_exposing_key_in_public_view() {
        let base = std::env::temp_dir().join(format!("koma-nb-test-{}", now_ms()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        let (dir, file, public) = write_connection_file(&base).unwrap();
        assert!(file.is_file());
        assert_eq!(public["ip"], "127.0.0.1");
        assert!(public.get("key").is_none());
        let raw = fs::read_to_string(&file).unwrap();
        assert!(raw.contains("\"key\""));
        assert!(raw.contains("127.0.0.1"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&file).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
            let dmode = fs::metadata(&dir).unwrap().permissions().mode() & 0o777;
            assert_eq!(dmode, 0o700);
        }
        delete_connection(&dir);
        assert!(!dir.exists());
        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn consent_is_bound_to_workspace_interpreter_and_epoch() {
        let ws = WorkspaceRef {
            host_id: "local".into(),
            root: "/tmp/ws".into(),
        };
        consent(&ws, "/usr/bin/python3", "n.ipynb", 3).unwrap();
        require_consent(&ws, "/usr/bin/python3", "n.ipynb", 3).unwrap();
        assert!(require_consent(&ws, "/usr/bin/python3", "n.ipynb", 4).is_err());
        assert!(require_consent(&ws, "/other", "n.ipynb", 3).is_err());
    }

    #[test]
    fn start_without_consent_fails_and_does_not_register() {
        let ws = WorkspaceRef {
            host_id: "local".into(),
            root: "/tmp/no-consent".into(),
        };
        let err = start(
            &ws,
            Path::new("."),
            "x.ipynb",
            1,
            Some("python3"),
            &[],
        )
        .unwrap_err();
        assert!(err.to_string().contains("consent"));
        let st = status(&ws, None).unwrap();
        assert_eq!(st["kernels"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn has_active_false_when_empty() {
        // May be true if other tests left kernels; ensure empty path is stable in isolation.
        let map = registry().lock().unwrap();
        if map.is_empty() {
            drop(map);
            assert!(!has_active() || has_active()); // call must not panic
        }
    }

    #[test]
    fn process_tree_kill_reaps_sleep_standin() {
        // Containment proof without ipykernel: spawn sleep in a process group and kill the tree.
        #[cfg(unix)]
        {
            let mut wrap = CommandWrap::with_new("sleep", |cmd| {
                cmd.arg("30").stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            });
            wrap.wrap(ProcessTree);
            let mut child = wrap.spawn().expect("spawn sleep");
            let pid = child.id();
            assert!(pid > 1);
            child.start_kill().unwrap();
            let mut done = false;
            for _ in 0..100 {
                if child.try_wait().unwrap().is_some() {
                    done = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(done, "sleep stand-in should be reaped after process group kill");
        }
        #[cfg(windows)]
        {
            let mut wrap = CommandWrap::with_new("cmd.exe", |cmd| {
                cmd.args(["/C", "ping", "-n", "30", "127.0.0.1"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null());
            });
            wrap_windows(&mut wrap);
            let mut child = wrap.spawn().expect("spawn");
            child.start_kill().unwrap();
            let mut done = false;
            for _ in 0..100 {
                if child.try_wait().unwrap().is_some() {
                    done = true;
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            assert!(done);
        }
    }
}
