//! Jupyter shell/IOPub client bound to a live kernel session.
//!
//! Runs on a dedicated OS thread with a current-thread tokio runtime (zeromq is async).
//! Connection keys never leave this module via CodingEvent payloads.

use super::notebook_wire::{
    self, cap_content_for_event, decode_frames, encode_execute_request, encode_input_reply_empty,
    encode_interrupt_request, encode_kernel_info_request, scrub_secrets, validate_connection_public,
    JupyterMessage, MAX_CONTENT_BYTES,
};
use super::WorkspaceRef;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use zeromq::{DealerSocket, Socket, SocketRecv, SocketSend, SubSocket, ZmqMessage};

const EVENT_CONTENT_CAP: usize = 256 * 1024;
const MAX_PENDING_EVENTS: usize = 256;
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const IOPUB_IDLE_POLL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone)]
pub struct ConnectionInfo {
    pub key: Vec<u8>,
    pub ip: String,
    pub transport: String,
    pub shell_port: u16,
    pub iopub_port: u16,
    pub stdin_port: u16,
    pub control_port: u16,
}

impl ConnectionInfo {
    pub fn from_file(path: &Path) -> Result<Self> {
        let raw = fs::read_to_string(path).context("Read kernel connection file")?;
        let v: Value = serde_json::from_str(&raw).context("Parse kernel connection file")?;
        let key = v
            .get("key")
            .and_then(Value::as_str)
            .context("Connection file missing key")?
            .as_bytes()
            .to_vec();
        let ip = v
            .get("ip")
            .and_then(Value::as_str)
            .unwrap_or("127.0.0.1")
            .to_string();
        let transport = v
            .get("transport")
            .and_then(Value::as_str)
            .unwrap_or("tcp")
            .to_string();
        let signature_scheme = v
            .get("signature_scheme")
            .and_then(Value::as_str)
            .unwrap_or("hmac-sha256");
        validate_connection_public(&ip, &transport, signature_scheme)?;
        let port = |name: &str| -> Result<u16> {
            v.get(name)
                .and_then(Value::as_u64)
                .and_then(|n| u16::try_from(n).ok())
                .with_context(|| format!("Connection file missing {name}"))
        };
        // Require hb_port in the file (Jupyter always writes it) without retaining it —
        // heartbeat is not used by the v1 client.
        let _hb = port("hb_port")?;
        Ok(Self {
            key,
            ip,
            transport,
            shell_port: port("shell_port")?,
            iopub_port: port("iopub_port")?,
            stdin_port: port("stdin_port")?,
            control_port: port("control_port")?,
        })
    }

    fn endpoint(&self, port: u16) -> String {
        format!("{}://{}:{}", self.transport, self.ip, port)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelRunState {
    Starting,
    Idle,
    Busy,
    Dead,
}

impl KernelRunState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Idle => "idle",
            Self::Busy => "busy",
            Self::Dead => "dead",
        }
    }
}

enum ClientCmd {
    Execute {
        code: String,
        generation: u64,
        cell_id: Option<String>,
        document_epoch: u64,
        reply: mpsc::Sender<Result<Value>>,
    },
    Interrupt {
        reply: mpsc::Sender<Result<()>>,
    },
    Shutdown,
}

struct SharedState {
    run_state: Mutex<KernelRunState>,
    generation: AtomicU64,
    /// In-flight execute msg_id (at most one per kernel in v1).
    inflight_msg_id: Mutex<Option<String>>,
    alive: AtomicBool,
}

/// Handle held by KernelSession.
pub struct ClientHandle {
    cmd_tx: Mutex<Option<mpsc::Sender<ClientCmd>>>,
    shared: Arc<SharedState>,
    join: Mutex<Option<JoinHandle<()>>>,
}

impl ClientHandle {
    pub fn run_state(&self) -> KernelRunState {
        self.shared
            .run_state
            .lock()
            .map(|g| *g)
            .unwrap_or(KernelRunState::Dead)
    }

    pub fn is_alive(&self) -> bool {
        self.shared.alive.load(Ordering::Acquire)
    }

    pub fn execute(
        &self,
        code: String,
        generation: u64,
        cell_id: Option<String>,
        document_epoch: u64,
    ) -> Result<Value> {
        anyhow::ensure!(code.len() <= MAX_CONTENT_BYTES / 2, "Cell code exceeds size bound");
        let (reply_tx, reply_rx) = mpsc::channel();
        let tx = self
            .cmd_tx
            .lock()
            .map_err(|_| anyhow::anyhow!("Client command lock poisoned"))?
            .as_ref()
            .cloned()
            .context("Notebook client is not running")?;
        tx.send(ClientCmd::Execute {
            code,
            generation,
            cell_id,
            document_epoch,
            reply: reply_tx,
        })
        .context("Notebook client stopped")?;
        reply_rx
            .recv_timeout(Duration::from_secs(120))
            .context("Execute timed out waiting for client thread")?
    }

    pub fn interrupt_control(&self) -> Result<()> {
        let (reply_tx, reply_rx) = mpsc::channel();
        let tx = self
            .cmd_tx
            .lock()
            .map_err(|_| anyhow::anyhow!("Client command lock poisoned"))?
            .as_ref()
            .cloned()
            .context("Notebook client is not running")?;
        tx.send(ClientCmd::Interrupt { reply: reply_tx })
            .context("Notebook client stopped")?;
        reply_rx
            .recv_timeout(Duration::from_secs(5))
            .context("Interrupt control timed out")?
    }

    pub fn shutdown(&self) {
        self.shared.alive.store(false, Ordering::Release);
        if let Ok(mut slot) = self.cmd_tx.lock() {
            if let Some(tx) = slot.take() {
                let _ = tx.send(ClientCmd::Shutdown);
            }
        }
        if let Ok(mut join) = self.join.lock() {
            if let Some(handle) = join.take() {
                let _ = handle.join();
            }
        }
        if let Ok(mut st) = self.shared.run_state.lock() {
            *st = KernelRunState::Dead;
        }
    }
}

impl Drop for ClientHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn emit_event(workspace: &WorkspaceRef, event: Value) {
    if scrub_secrets(&event) {
        // Refuse to push anything that looks like connection material.
        return;
    }
    super::event(json!({
        "k": "CodingEvent",
        "workspace": workspace,
        "event": event,
    }));
}

fn set_state(shared: &SharedState, workspace: &WorkspaceRef, path: &str, state: KernelRunState) {
    if let Ok(mut g) = shared.run_state.lock() {
        *g = state;
    }
    emit_event(
        workspace,
        json!({
            "k": "NotebookKernelState",
            "status": state.as_str(),
            "generation": shared.generation.load(Ordering::Acquire),
            "documentPath": path,
        }),
    );
}

fn frames_to_zmq(frames: Vec<Vec<u8>>) -> Result<ZmqMessage> {
    use bytes::Bytes;
    let mut msg = ZmqMessage::from(Bytes::from(frames[0].clone()));
    for frame in frames.into_iter().skip(1) {
        msg.push_back(Bytes::from(frame));
    }
    Ok(msg)
}

fn zmq_to_frames(msg: ZmqMessage) -> Vec<Vec<u8>> {
    msg.into_vec().into_iter().map(|b| b.to_vec()).collect()
}

/// Spawn the client thread and wait until kernel_info succeeds or timeout.
pub fn start_client(
    workspace: WorkspaceRef,
    document_path: String,
    connection_file: &Path,
    generation: u64,
) -> Result<ClientHandle> {
    let info = ConnectionInfo::from_file(connection_file)?;
    // Wipe key from any accidental Debug later — held only inside thread after move.
    let (cmd_tx, cmd_rx) = mpsc::channel::<ClientCmd>();
    let shared = Arc::new(SharedState {
        run_state: Mutex::new(KernelRunState::Starting),
        generation: AtomicU64::new(generation),
        inflight_msg_id: Mutex::new(None),
        alive: AtomicBool::new(true),
    });
    let (ready_tx, ready_rx) = mpsc::channel::<Result<()>>();
    let shared_thread = Arc::clone(&shared);
    let join = thread::Builder::new()
        .name("notebook-zmq".into())
        .spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let rt = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(rt) => rt,
                    Err(err) => {
                        let _ = ready_tx.send(Err(anyhow::anyhow!("tokio runtime: {err}")));
                        return;
                    }
                };
                rt.block_on(client_main(
                    workspace,
                    document_path,
                    info,
                    shared_thread,
                    cmd_rx,
                    ready_tx,
                ));
            }));
            if result.is_err() {
                // panic already reported via ready/state if possible
            }
        })
        .context("Spawn notebook client thread")?;

    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => {}
        Ok(Err(err)) => {
            shared.alive.store(false, Ordering::Release);
            let _ = join.join();
            return Err(err);
        }
        Err(_) => {
            shared.alive.store(false, Ordering::Release);
            let _ = join.join();
            bail!("Timed out waiting for notebook kernel ready");
        }
    }

    Ok(ClientHandle {
        cmd_tx: Mutex::new(Some(cmd_tx)),
        shared,
        join: Mutex::new(Some(join)),
    })
}

async fn client_main(
    workspace: WorkspaceRef,
    document_path: String,
    info: ConnectionInfo,
    shared: Arc<SharedState>,
    cmd_rx: mpsc::Receiver<ClientCmd>,
    ready_tx: mpsc::Sender<Result<()>>,
) {
    let outcome = client_main_inner(
        workspace.clone(),
        document_path.clone(),
        info,
        Arc::clone(&shared),
        cmd_rx,
        ready_tx,
    )
    .await;
    shared.alive.store(false, Ordering::Release);
    if let Ok(mut st) = shared.run_state.lock() {
        *st = KernelRunState::Dead;
    }
    emit_event(
        &workspace,
        json!({
            "k": "NotebookKernelState",
            "status": "dead",
            "generation": shared.generation.load(Ordering::Acquire),
            "documentPath": document_path,
            "error": outcome.err().map(|e| e.to_string()),
        }),
    );
}

async fn client_main_inner(
    workspace: WorkspaceRef,
    document_path: String,
    info: ConnectionInfo,
    shared: Arc<SharedState>,
    cmd_rx: mpsc::Receiver<ClientCmd>,
    ready_tx: mpsc::Sender<Result<()>>,
) -> Result<()> {
    let session = notebook_wire::new_msg_id();
    let key = info.key.clone();

    let mut shell = DealerSocket::new();
    let mut control = DealerSocket::new();
    let mut stdin = DealerSocket::new();
    let mut iopub = SubSocket::new();

    shell
        .connect(&info.endpoint(info.shell_port))
        .await
        .context("Connect shell")?;
    control
        .connect(&info.endpoint(info.control_port))
        .await
        .context("Connect control")?;
    stdin
        .connect(&info.endpoint(info.stdin_port))
        .await
        .context("Connect stdin")?;
    iopub
        .connect(&info.endpoint(info.iopub_port))
        .await
        .context("Connect iopub")?;
    iopub.subscribe("").await.context("Subscribe iopub")?;

    // kernel_info handshake
    let (info_id, frames) = encode_kernel_info_request(&key, &session)?;
    shell
        .send(frames_to_zmq(frames)?)
        .await
        .context("Send kernel_info_request")?;

    let ready = wait_kernel_info(&mut shell, &mut iopub, &key, &info_id, Duration::from_secs(25)).await;
    match ready {
        Ok(()) => {
            set_state(&shared, &workspace, &document_path, KernelRunState::Idle);
            let _ = ready_tx.send(Ok(()));
        }
        Err(err) => {
            let _ = ready_tx.send(Err(anyhow::anyhow!("{err:#}")));
            return Err(err);
        }
    }

    let mut event_budget = 0usize;
    while shared.alive.load(Ordering::Acquire) {
        // Drain commands without blocking the async runtime too long.
        match cmd_rx.recv_timeout(IOPUB_IDLE_POLL) {
            Ok(ClientCmd::Shutdown) => break,
            Ok(ClientCmd::Interrupt { reply }) => {
                let result = send_interrupt(&mut control, &key, &session).await;
                let _ = reply.send(result);
            }
            Ok(ClientCmd::Execute {
                code,
                generation,
                cell_id,
                document_epoch,
                reply,
            }) => {
                let result = run_execute(
                    &mut shell,
                    &mut iopub,
                    &mut stdin,
                    &key,
                    &session,
                    &shared,
                    &workspace,
                    &document_path,
                    code,
                    generation,
                    cell_id,
                    document_epoch,
                    &mut event_budget,
                )
                .await;
                event_budget = 0;
                let _ = reply.send(result);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Opportunistic IOPub drain (status / late messages).
                drain_iopub_once(
                    &mut iopub,
                    &key,
                    &shared,
                    &workspace,
                    &document_path,
                    None,
                    &mut event_budget,
                )
                .await;
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    Ok(())
}

async fn send_interrupt(control: &mut DealerSocket, key: &[u8], session: &str) -> Result<()> {
    let (_id, frames) = encode_interrupt_request(key, session)?;
    control
        .send(frames_to_zmq(frames)?)
        .await
        .context("Send interrupt_request")?;
    Ok(())
}

async fn wait_kernel_info(
    shell: &mut DealerSocket,
    iopub: &mut SubSocket,
    key: &[u8],
    expect_id: &str,
    timeout: Duration,
) -> Result<()> {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if tokio::time::Instant::now() > deadline {
            bail!("kernel_info_request timed out");
        }
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        tokio::select! {
            msg = shell.recv() => {
                let msg = msg.context("shell recv")?;
                if let Ok(decoded) = decode_frames(key, &zmq_to_frames(msg)) {
                    if decoded.msg_type() == Some("kernel_info_reply")
                        && notebook_wire::correlates(decoded.parent_msg_id(), expect_id)
                    {
                        return Ok(());
                    }
                }
            }
            msg = iopub.recv() => {
                let msg = msg.context("iopub recv")?;
                let _ = decode_frames(key, &zmq_to_frames(msg));
            }
            _ = tokio::time::sleep(remaining.min(Duration::from_millis(200))) => {}
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_execute(
    shell: &mut DealerSocket,
    iopub: &mut SubSocket,
    stdin: &mut DealerSocket,
    key: &[u8],
    session: &str,
    shared: &SharedState,
    workspace: &WorkspaceRef,
    document_path: &str,
    code: String,
    generation: u64,
    cell_id: Option<String>,
    document_epoch: u64,
    event_budget: &mut usize,
) -> Result<Value> {
    let current_gen = shared.generation.load(Ordering::Acquire);
    anyhow::ensure!(
        generation == current_gen,
        "Stale execute generation (kernel restarted)"
    );
    let (msg_id, frames) = {
        let mut inflight = shared
            .inflight_msg_id
            .lock()
            .map_err(|_| anyhow::anyhow!("inflight lock poisoned"))?;
        anyhow::ensure!(inflight.is_none(), "Kernel already has an in-flight execute");
        let (msg_id, frames) = encode_execute_request(key, session, &code, false)?;
        *inflight = Some(msg_id.clone());
        (msg_id, frames)
    };
    set_state(shared, workspace, document_path, KernelRunState::Busy);
    if let Err(err) = shell
        .send(frames_to_zmq(frames)?)
        .await
        .context("Send execute_request")
    {
        if let Ok(mut inflight) = shared.inflight_msg_id.lock() {
            *inflight = None;
        }
        return Err(err);
    }

    let result = wait_execute_reply(
        shell,
        iopub,
        stdin,
        key,
        session,
        shared,
        workspace,
        document_path,
        &msg_id,
        cell_id.as_deref(),
        document_epoch,
        generation,
        event_budget,
    )
    .await;
    if let Ok(mut inflight) = shared.inflight_msg_id.lock() {
        *inflight = None;
    }
    // Return to idle unless dead.
    if shared.alive.load(Ordering::Acquire)
        && shared
            .run_state
            .lock()
            .map(|s| *s)
            .unwrap_or(KernelRunState::Dead)
            != KernelRunState::Dead
    {
        set_state(shared, workspace, document_path, KernelRunState::Idle);
    }
    result
}

#[allow(clippy::too_many_arguments)]
async fn wait_execute_reply(
    shell: &mut DealerSocket,
    iopub: &mut SubSocket,
    stdin: &mut DealerSocket,
    key: &[u8],
    session: &str,
    shared: &SharedState,
    workspace: &WorkspaceRef,
    document_path: &str,
    msg_id: &str,
    cell_id: Option<&str>,
    document_epoch: u64,
    generation: u64,
    event_budget: &mut usize,
) -> Result<Value> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(600);
    loop {
        if !shared.alive.load(Ordering::Acquire) {
            bail!("Kernel client stopped during execute");
        }
        if tokio::time::Instant::now() > deadline {
            bail!("execute_request timed out");
        }
        tokio::select! {
            msg = shell.recv() => {
                let msg = msg.context("shell recv during execute")?;
                if let Ok(decoded) = decode_frames(key, &zmq_to_frames(msg)) {
                    if decoded.msg_type() == Some("execute_reply")
                        && notebook_wire::correlates(decoded.parent_msg_id(), msg_id)
                    {
                        let status = decoded
                            .content
                            .get("status")
                            .and_then(Value::as_str)
                            .unwrap_or("ok");
                        let execution_count = decoded.content.get("execution_count").cloned();
                        let payload = json!({
                            "k": "NotebookExecuteReply",
                            "status": status,
                            "executionCount": execution_count,
                            "parentMsgId": msg_id,
                            "generation": generation,
                            "documentPath": document_path,
                            "documentEpoch": document_epoch,
                            "cellId": cell_id,
                        });
                        emit_event(workspace, payload.clone());
                        return Ok(json!({
                            "status": status,
                            "executionCount": execution_count,
                            "parentMsgId": msg_id,
                            "generation": generation,
                        }));
                    }
                }
            }
            msg = iopub.recv() => {
                let msg = msg.context("iopub recv during execute")?;
                if let Ok(decoded) = decode_frames(key, &zmq_to_frames(msg)) {
                    handle_iopub_msg(
                        &decoded,
                        shared,
                        workspace,
                        document_path,
                        Some(msg_id),
                        event_budget,
                    ).await;
                }
            }
            msg = stdin.recv() => {
                // v1: refuse interactive input.
                if let Ok(msg) = msg {
                    if let Ok(decoded) = decode_frames(key, &zmq_to_frames(msg)) {
                        if decoded.msg_type() == Some("input_request") {
                            let frames = encode_input_reply_empty(key, session, &decoded.header)?;
                            let _ = stdin.send(frames_to_zmq(frames)?).await;
                            emit_event(workspace, json!({
                                "k": "NotebookIo",
                                "parentMsgId": msg_id,
                                "msgType": "input_request",
                                "payload": {"error": "Interactive input is not supported yet"},
                                "generation": shared.generation.load(Ordering::Acquire),
                                "documentPath": document_path,
                            }));
                        }
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

async fn drain_iopub_once(
    iopub: &mut SubSocket,
    key: &[u8],
    shared: &SharedState,
    workspace: &WorkspaceRef,
    document_path: &str,
    filter_parent: Option<&str>,
    event_budget: &mut usize,
) {
    let result = tokio::time::timeout(Duration::from_millis(5), iopub.recv()).await;
    if let Ok(Ok(msg)) = result {
        if let Ok(decoded) = decode_frames(key, &zmq_to_frames(msg)) {
            handle_iopub_msg(
                &decoded,
                shared,
                workspace,
                document_path,
                filter_parent,
                event_budget,
            )
            .await;
        }
    }
}

async fn handle_iopub_msg(
    decoded: &JupyterMessage,
    shared: &SharedState,
    workspace: &WorkspaceRef,
    document_path: &str,
    filter_parent: Option<&str>,
    event_budget: &mut usize,
) {
    let msg_type = decoded.msg_type().unwrap_or("");
    if msg_type == "status" {
        if let Some(state) = decoded
            .content
            .get("execution_state")
            .and_then(Value::as_str)
        {
            let mapped = match state {
                "busy" => KernelRunState::Busy,
                "idle" => KernelRunState::Idle,
                "starting" => KernelRunState::Starting,
                _ => return,
            };
            // Don't clobber dead.
            if shared
                .run_state
                .lock()
                .map(|s| *s != KernelRunState::Dead)
                .unwrap_or(false)
            {
                set_state(shared, workspace, document_path, mapped);
            }
        }
        return;
    }

    // Only forward IO for known output message types.
    let interesting = matches!(
        msg_type,
        "stream"
            | "execute_result"
            | "display_data"
            | "error"
            | "execute_input"
            | "clear_output"
    );
    if !interesting {
        return;
    }
    if let Some(expected) = filter_parent {
        if let Some(parent) = decoded.parent_msg_id() {
            if parent != expected {
                return;
            }
        }
    }
    if *event_budget >= MAX_PENDING_EVENTS {
        return;
    }
    *event_budget += 1;

    let mut content = decoded.content.clone();
    content = cap_content_for_event(content, EVENT_CONTENT_CAP);
    if scrub_secrets(&content) {
        return;
    }
    emit_event(
        workspace,
        json!({
            "k": "NotebookIo",
            "parentMsgId": decoded.parent_msg_id(),
            "msgType": msg_type,
            "payload": content,
            "generation": shared.generation.load(Ordering::Acquire),
            "documentPath": document_path,
        }),
    );
}
