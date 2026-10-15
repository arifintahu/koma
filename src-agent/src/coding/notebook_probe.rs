//! Opt-in BasedPyright `notebookDocumentSync` capability probe (M2 gate).
//!
//! ```bash
//! KOMA_LSP_NOTEBOOK_PROBE=1 cargo test -p agent --no-default-features coding::notebook_probe -- --ignored --nocapture
//! ```
//!
//! Default UI stays Unavailable until this probe records a positive result against
//! the pinned basedpyright-langserver install. No cell-concat fallback.

use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

fn default_langserver() -> PathBuf {
    if let Ok(p) = std::env::var("KOMA_BASED_PYRIGHT") {
        return PathBuf::from(p);
    }
    dirs::home_dir()
        .map(|h| h.join(".koma/lsp/basedpyright/venv/bin/basedpyright-langserver"))
        .unwrap_or_else(|| PathBuf::from("basedpyright-langserver"))
}

fn write_rpc(
    stdin: &mut impl Write,
    id: Option<u64>,
    method: &str,
    params: Value,
) -> std::io::Result<()> {
    let mut body = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    if let Some(id) = id {
        body["id"] = json!(id);
    }
    let data = serde_json::to_vec(&body)?;
    write!(stdin, "Content-Length: {}\r\n\r\n", data.len())?;
    stdin.write_all(&data)?;
    stdin.flush()
}

fn read_rpc(stdout: &mut impl BufRead) -> std::io::Result<Value> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        let n = stdout.read_line(&mut line)?;
        if n == 0 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::UnexpectedEof,
                "LSP stdout closed",
            ));
        }
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            break;
        }
        if let Some(rest) = trimmed.strip_prefix("Content-Length:") {
            content_length = Some(
                rest.trim()
                    .parse::<usize>()
                    .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?,
            );
        }
    }
    let len = content_length.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, "missing Content-Length")
    })?;
    let mut buf = vec![0u8; len];
    stdout.read_exact(&mut buf)?;
    serde_json::from_slice(&buf)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Probe result for docs / UI reason strings.
#[derive(Debug, Clone)]
pub struct NotebookProbeResult {
    pub binary: PathBuf,
    pub notebook_document_sync: bool,
    pub raw_capabilities: Value,
    pub note: String,
}

/// Spawn basedpyright-langserver and inspect initialize capabilities.
pub fn probe_notebook_document_sync(binary: &Path) -> anyhow::Result<NotebookProbeResult> {
    anyhow::ensure!(
        binary.is_file() || binary.components().count() == 1,
        "basedpyright-langserver not found at {}",
        binary.display()
    );
    let mut child = Command::new(binary)
        .arg("--stdio")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| anyhow::anyhow!("spawn {}: {e}", binary.display()))?;
    let mut stdin = child.stdin.take().expect("stdin");
    let stdout = child.stdout.take().expect("stdout");
    let mut reader = BufReader::new(stdout);

    write_rpc(
        &mut stdin,
        Some(1),
        "initialize",
        json!({
            "processId": std::process::id(),
            "capabilities": {
                "notebookDocument": {
                    "synchronization": {
                        "dynamicRegistration": false,
                        "executionSummarySupport": false
                    }
                }
            },
            "rootUri": null,
            "clientInfo": { "name": "koma-notebook-probe", "version": env!("CARGO_PKG_VERSION") }
        }),
    )?;

    // Read until we get the initialize result (id=1). Cap messages.
    let mut caps = Value::Null;
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    while std::time::Instant::now() < deadline {
        let msg = read_rpc(&mut reader)?;
        if msg.get("id") == Some(&json!(1)) {
            caps = msg
                .pointer("/result/capabilities")
                .cloned()
                .unwrap_or(Value::Null);
            break;
        }
    }

    let sync = caps.get("notebookDocumentSync").is_some()
        || caps.pointer("/notebookDocument/synchronization").is_some();

    let _ = write_rpc(&mut stdin, Some(2), "shutdown", json!(null));
    let _ = write_rpc(&mut stdin, None, "exit", json!(null));
    let _ = child.kill();
    let _ = child.wait();

    Ok(NotebookProbeResult {
        binary: binary.to_path_buf(),
        notebook_document_sync: sync,
        raw_capabilities: caps.clone(),
        note: if sync {
            "basedpyright advertises notebookDocumentSync — Analysis wiring may proceed (C3)".into()
        } else {
            "basedpyright did not advertise notebookDocumentSync — Analysis stays Unavailable"
                .into()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore]
    fn basedpyright_notebook_document_sync_probe() {
        if std::env::var_os("KOMA_LSP_NOTEBOOK_PROBE").is_none() {
            eprintln!("skip: set KOMA_LSP_NOTEBOOK_PROBE=1");
            return;
        }
        let bin = default_langserver();
        match probe_notebook_document_sync(&bin) {
            Ok(result) => {
                eprintln!("binary: {}", result.binary.display());
                eprintln!("notebookDocumentSync: {}", result.notebook_document_sync);
                eprintln!("note: {}", result.note);
                eprintln!(
                    "capabilities keys: {:?}",
                    result
                        .raw_capabilities
                        .as_object()
                        .map(|o| o.keys().collect::<Vec<_>>())
                );
                // Do not assert true — missing sync is the expected default.
                // Recording evidence is the success condition of the probe harness.
            }
            Err(err) => {
                eprintln!("probe failed: {err:#}");
                // Soft-fail when binary missing so CI without packs stays green when ignored.
            }
        }
    }
}
