//! Public wire types. No private IPC structs are serialized on stdout.
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufRead, AsyncBufReadExt};

pub const MAX_LINE: usize = 40 * 1024 * 1024;
pub const METHODS: &[&str] = &[
    "create",
    "resume",
    "state",
    "submit",
    "enqueue",
    "interrupt",
    "interrupt_and_submit",
    "approve",
    "configure",
    "detach",
];
#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: String,
    pub method: String,
    pub params: serde_json::Value,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Plan {
    Allow,
    Forbid,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Approval {
    Default,
    Reject,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Policy {
    pub plan: Plan,
    pub approval: Approval,
}
impl Default for Policy {
    fn default() -> Self {
        Self {
            plan: Plan::Forbid,
            approval: Approval::Reject,
        }
    }
}
#[derive(Debug, Deserialize)]
pub struct Create {
    pub cwd: String,
    pub model_id: Option<String>,
    pub policy: Option<Policy>,
    #[serde(default)]
    pub external_approvals: bool,
}
#[derive(Debug, Deserialize)]
pub struct Resume {
    pub session_id: String,
    pub policy: Option<Policy>,
    #[serde(default)]
    pub external_approvals: bool,
}
#[derive(Debug, Deserialize)]
pub struct Input {
    pub text: String,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Attachment {
    ImageFile { path: String },
    PastedText { text: String, name: Option<String> },
}
#[derive(Debug, Deserialize)]
pub struct Target {
    pub turn_id: String,
}
#[derive(Debug, Deserialize)]
pub struct Replacement {
    pub turn_id: String,
    #[serde(flatten)]
    pub input: Input,
}
#[derive(Debug, Deserialize)]
pub struct Decision {
    pub call_id: String,
    pub approve: bool,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Message {
    pub role: &'static str,
    pub content: String,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Turn {
    pub id: String,
    pub state: &'static str,
    pub error: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct PendingApproval {
    pub call_id: String,
    pub reason: Option<String>,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Gate {
    pub kind: &'static str,
    pub reason: Option<String>,
    pub supported: bool,
}
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct State {
    pub revision: u64,
    pub external_approvals: bool,
    pub pending_approval: Option<PendingApproval>,
    pub gate: Option<Gate>,
    #[serde(skip)]
    pub resync: u64,
    pub session_id: String,
    pub cwd: String,
    pub model_id: String,
    pub policy: Policy,
    pub turn: Option<Turn>,
    pub working: bool,
    pub awaiting_approval: bool,
    pub approval_reason: Option<String>,
    pub pending_count: usize,
    pub messages: Vec<Message>,
    pub streaming: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct RpcError {
    pub code: &'static str,
    pub message: String,
    pub delivery: &'static str,
}
impl RpcError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            delivery: "not_sent",
        }
    }
    pub fn unknown(e: impl std::fmt::Display) -> Self {
        Self {
            code: "unavailable",
            message: e.to_string(),
            delivery: "unknown",
        }
    }
}
pub fn params<T: serde::de::DeserializeOwned>(v: serde_json::Value) -> Result<T, RpcError> {
    if !v.is_object() {
        return Err(RpcError::new("invalid_request", "params must be an object"));
    }
    serde_json::from_value(v).map_err(|e| RpcError::new("invalid_request", e.to_string()))
}
/// Incremental bounded reader: never allocates an unbounded read_until buffer.
pub async fn line<R: AsyncBufRead + Unpin>(r: &mut R) -> anyhow::Result<Option<Vec<u8>>> {
    let mut out = Vec::new();
    loop {
        let chunk = r.fill_buf().await?;
        if chunk.is_empty() {
            anyhow::ensure!(out.is_empty(), "unterminated JSONL frame");
            return Ok(None);
        }
        let n = chunk.iter().position(|b| *b == b'\n');
        let take = n.unwrap_or(chunk.len());
        anyhow::ensure!(out.len() + take <= MAX_LINE, "JSONL frame exceeds 40 MiB");
        out.extend_from_slice(&chunk[..take]);
        r.consume(take + usize::from(n.is_some()));
        if n.is_some() {
            if out.last() == Some(&b'\r') {
                out.pop();
            }
            anyhow::ensure!(!out.is_empty(), "blank JSONL frame");
            return Ok(Some(out));
        }
    }
}
pub fn attachments(
    input: Input,
) -> Result<(String, Vec<crate::ipc::proto::TurnAttachmentInput>), RpcError> {
    use crate::ipc::proto::TurnAttachmentInput as A;
    if input.text.trim().is_empty()
        || input.text.len() > 2 * 1024 * 1024
        || input.attachments.len() > 16
    {
        return Err(RpcError::new(
            "invalid_request",
            "invalid prompt or attachment count",
        ));
    }
    let mut total = 0u64;
    let mut out = Vec::new();
    for a in input.attachments {
        out.push(match a {
            Attachment::PastedText { text, name } => {
                if text.len() > 2 * 1024 * 1024 {
                    return Err(RpcError::new(
                        "invalid_request",
                        "pasted text exceeds 2 MiB",
                    ));
                }
                total += text.len() as u64;
                A::PastedText { text, name }
            }
            Attachment::ImageFile { path } => {
                let p = std::path::Path::new(&path);
                if !p.is_absolute() {
                    return Err(RpcError::new(
                        "invalid_request",
                        "image path must be absolute",
                    ));
                }
                let m = std::fs::metadata(p).map_err(|_| {
                    RpcError::new("invalid_request", "image is not a readable regular file")
                })?;
                if !m.is_file() {
                    return Err(RpcError::new(
                        "invalid_request",
                        "image is not a regular file",
                    ));
                }
                total += m.len();
                A::ImageFile { path }
            }
        });
        if total > 32 * 1024 * 1024 {
            return Err(RpcError::new(
                "invalid_request",
                "attachments exceed 32 MiB",
            ));
        }
    }
    Ok((input.text, out))
}
