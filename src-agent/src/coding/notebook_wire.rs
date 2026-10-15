//! Jupyter wire-protocol encode/decode (HMAC-SHA256 multipart).
//!
//! Frames after optional identity prefixes:
//! `[ <IDS|MSG>, signature, header, parent_header, metadata, content, *buffers ]`
//!
//! Signature is hex(HMAC-SHA256(key, header || parent || metadata || content)).
//! Keys stay native-side — this module never logs or returns the key.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub const DELIM: &[u8] = b"<IDS|MSG>";
pub const MAX_CONTENT_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BUFFER_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_BUFFERS: usize = 8;

/// One decoded Jupyter message (identity frames stripped).
///
/// Metadata, binary buffers, and the hex signature are validated during decode
/// and not retained — the v1 client only needs header/parent/content.
#[derive(Debug, Clone)]
pub struct JupyterMessage {
    pub header: Value,
    pub parent_header: Value,
    pub content: Value,
}

impl JupyterMessage {
    pub fn msg_type(&self) -> Option<&str> {
        self.header.get("msg_type").and_then(Value::as_str)
    }

    pub fn parent_msg_id(&self) -> Option<&str> {
        self.parent_header.get("msg_id").and_then(Value::as_str)
    }
}

/// Compact JSON for signing — byte-stable for a given Value tree.
pub fn dump_json(value: &Value) -> Result<String> {
    serde_json::to_string(value).context("Serialize Jupyter JSON frame")
}

/// HMAC-SHA256 hex digest over the four signed frames (UTF-8 bytes concatenated).
pub fn sign_hex(key: &[u8], header: &str, parent: &str, metadata: &str, content: &str) -> String {
    let mut data = Vec::with_capacity(header.len() + parent.len() + metadata.len() + content.len());
    data.extend_from_slice(header.as_bytes());
    data.extend_from_slice(parent.as_bytes());
    data.extend_from_slice(metadata.as_bytes());
    data.extend_from_slice(content.as_bytes());
    hex_encode(&hmac_sha256(key, &data))
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK: usize = 64;
    let mut key_block = [0u8; BLOCK];
    if key.len() > BLOCK {
        let digested = Sha256::digest(key);
        key_block[..digested.len()].copy_from_slice(&digested);
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }
    let mut ipad = [0x36u8; BLOCK];
    let mut opad = [0x5cu8; BLOCK];
    for i in 0..BLOCK {
        ipad[i] ^= key_block[i];
        opad[i] ^= key_block[i];
    }
    let mut inner = Sha256::new();
    inner.update(ipad);
    inner.update(message);
    let inner_hash = inner.finalize();
    let mut outer = Sha256::new();
    outer.update(opad);
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut arr = [0u8; 32];
    arr.copy_from_slice(&out);
    arr
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        s.push(HEX[(b >> 4) as usize] as char);
        s.push(HEX[(b & 0xf) as usize] as char);
    }
    s
}

fn constant_time_eq(a: &str, b: &str) -> bool {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    if ab.len() != bb.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..ab.len() {
        diff |= ab[i] ^ bb[i];
    }
    diff == 0
}

/// Build multipart frames ready to send on a DEALER/SUB client socket
/// (no identity prefix — DEALER adds its own).
pub fn encode_frames(
    key: &[u8],
    header: &Value,
    parent_header: &Value,
    metadata: &Value,
    content: &Value,
    buffers: &[Vec<u8>],
) -> Result<Vec<Vec<u8>>> {
    anyhow::ensure!(buffers.len() <= MAX_BUFFERS, "Too many Jupyter buffers");
    for buf in buffers {
        anyhow::ensure!(
            buf.len() <= MAX_BUFFER_BYTES,
            "Jupyter buffer exceeds size bound"
        );
    }
    let header_s = dump_json(header)?;
    let parent_s = dump_json(parent_header)?;
    let meta_s = dump_json(metadata)?;
    let content_s = dump_json(content)?;
    anyhow::ensure!(
        content_s.len() <= MAX_CONTENT_BYTES,
        "Jupyter content exceeds size bound"
    );
    let sig = sign_hex(key, &header_s, &parent_s, &meta_s, &content_s);
    let mut frames = Vec::with_capacity(6 + buffers.len());
    frames.push(DELIM.to_vec());
    frames.push(sig.into_bytes());
    frames.push(header_s.into_bytes());
    frames.push(parent_s.into_bytes());
    frames.push(meta_s.into_bytes());
    frames.push(content_s.into_bytes());
    for buf in buffers {
        frames.push(buf.clone());
    }
    Ok(frames)
}

/// Decode multipart frames. Accepts optional leading identity frames before `<IDS|MSG>`.
pub fn decode_frames(key: &[u8], frames: &[Vec<u8>]) -> Result<JupyterMessage> {
    let delim_idx = frames
        .iter()
        .position(|f| f.as_slice() == DELIM)
        .context("Jupyter message missing <IDS|MSG> delimiter")?;
    let rest = &frames[delim_idx + 1..];
    anyhow::ensure!(
        rest.len() >= 5,
        "Jupyter message truncated (need signature + 4 JSON frames)"
    );
    let signature = std::str::from_utf8(&rest[0]).context("Signature frame is not UTF-8")?;
    let header_s = std::str::from_utf8(&rest[1]).context("header frame is not UTF-8")?;
    let parent_s = std::str::from_utf8(&rest[2]).context("parent_header frame is not UTF-8")?;
    let meta_s = std::str::from_utf8(&rest[3]).context("metadata frame is not UTF-8")?;
    let content_s = std::str::from_utf8(&rest[4]).context("content frame is not UTF-8")?;
    anyhow::ensure!(
        content_s.len() <= MAX_CONTENT_BYTES,
        "Jupyter content exceeds size bound"
    );
    let expected = sign_hex(key, header_s, parent_s, meta_s, content_s);
    anyhow::ensure!(
        constant_time_eq(signature, &expected),
        "Jupyter HMAC signature mismatch"
    );
    // Bound binary frames; v1 does not surface them to the UI.
    anyhow::ensure!(rest[5..].len() <= MAX_BUFFERS, "Too many Jupyter buffers");
    for buf in &rest[5..] {
        anyhow::ensure!(
            buf.len() <= MAX_BUFFER_BYTES,
            "Jupyter buffer exceeds size bound"
        );
    }
    // Parse metadata so bad JSON fails closed; discard after (unused by v1 client).
    let _: Value = serde_json::from_str(meta_s).context("Parse metadata JSON")?;
    Ok(JupyterMessage {
        header: serde_json::from_str(header_s).context("Parse header JSON")?,
        parent_header: serde_json::from_str(parent_s).context("Parse parent_header JSON")?,
        content: serde_json::from_str(content_s).context("Parse content JSON")?,
    })
}

fn iso_now() -> String {
    // Jupyter accepts RFC3339-ish timestamps; second precision is enough for our client.
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Manual UTC format without chrono dep: enough for protocol, not wall-clock display.
    // 1970-01-01 baseline via simple conversion is heavy; use unix epoch string form accepted by kernels.
    format!("{secs}.0")
}

/// Mint a new msg_id (UUID-shaped hex).
pub fn new_msg_id() -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut bytes = [0u8; 16];
    // Prefer OS randomness.
    if fill_random(&mut bytes).is_err() {
        let mut h = DefaultHasher::new();
        SystemTime::now().hash(&mut h);
        std::thread::current().id().hash(&mut h);
        let n = h.finish();
        bytes[..8].copy_from_slice(&n.to_le_bytes());
        bytes[8..].copy_from_slice(&(n.wrapping_mul(0x9e3779b97f4a7c15)).to_le_bytes());
    }
    // UUID v4-ish string
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
    )
}

fn fill_random(buf: &mut [u8]) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::io::Read;
        std::fs::File::open("/dev/urandom")?.read_exact(buf)
    }
    #[cfg(windows)]
    {
        use std::collections::hash_map::DefaultHasher;
        use std::hash::{Hash, Hasher};
        let mut h = DefaultHasher::new();
        SystemTime::now().hash(&mut h);
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

/// Standard header fields for a client-originated message.
pub fn make_header(msg_type: &str, session: &str, msg_id: &str) -> Value {
    json!({
        "msg_id": msg_id,
        "msg_type": msg_type,
        "username": "koma",
        "session": session,
        "date": iso_now(),
        "version": "5.3",
    })
}

/// Build an `execute_request` content object (v1: no stdin).
pub fn execute_request_content(code: &str, silent: bool) -> Result<Value> {
    anyhow::ensure!(
        code.len() <= MAX_CONTENT_BYTES / 2,
        "Cell code exceeds size bound"
    );
    // Reject NULs that break kernel parsing.
    anyhow::ensure!(!code.contains('\0'), "Cell code must not contain NUL");
    Ok(json!({
        "code": code,
        "silent": silent,
        "store_history": !silent,
        "user_expressions": {},
        "allow_stdin": false,
        "stop_on_error": true,
    }))
}

/// Encode a full execute_request message.
pub fn encode_execute_request(
    key: &[u8],
    session: &str,
    code: &str,
    silent: bool,
) -> Result<(String, Vec<Vec<u8>>)> {
    let msg_id = new_msg_id();
    let header = make_header("execute_request", session, &msg_id);
    let content = execute_request_content(code, silent)?;
    let frames = encode_frames(key, &header, &json!({}), &json!({}), &content, &[])?;
    Ok((msg_id, frames))
}

/// Encode kernel_info_request.
pub fn encode_kernel_info_request(key: &[u8], session: &str) -> Result<(String, Vec<Vec<u8>>)> {
    let msg_id = new_msg_id();
    let header = make_header("kernel_info_request", session, &msg_id);
    let frames = encode_frames(key, &header, &json!({}), &json!({}), &json!({}), &[])?;
    Ok((msg_id, frames))
}

/// Encode interrupt_request (control channel).
pub fn encode_interrupt_request(key: &[u8], session: &str) -> Result<(String, Vec<Vec<u8>>)> {
    let msg_id = new_msg_id();
    let header = make_header("interrupt_request", session, &msg_id);
    let frames = encode_frames(key, &header, &json!({}), &json!({}), &json!({}), &[])?;
    Ok((msg_id, frames))
}

/// Encode input_reply that cancels/refuses stdin (v1).
pub fn encode_input_reply_empty(
    key: &[u8],
    session: &str,
    parent_header: &Value,
) -> Result<Vec<Vec<u8>>> {
    let msg_id = new_msg_id();
    let header = make_header("input_reply", session, &msg_id);
    let content = json!({ "value": "" });
    encode_frames(key, &header, parent_header, &json!({}), &content, &[])
}

/// Cap a raw Jupyter content Value for GUI events (drop oversized string leaves).
pub fn cap_content_for_event(mut content: Value, max_chars: usize) -> Value {
    fn walk(v: &mut Value, max: usize) {
        match v {
            Value::String(s) if s.len() > max => {
                s.truncate(max);
                s.push_str("\n… [truncated]");
            }
            Value::Array(arr) => {
                for item in arr.iter_mut() {
                    walk(item, max);
                }
            }
            Value::Object(map) => {
                for (_k, val) in map.iter_mut() {
                    walk(val, max);
                }
            }
            _ => {}
        }
    }
    walk(&mut content, max_chars);
    content
}

/// Strip any accidental key/port material from a Value before GUI emission.
pub fn scrub_secrets(value: &Value) -> bool {
    fn walk(v: &Value) -> bool {
        match v {
            Value::Object(map) => {
                for (k, val) in map {
                    let lk = k.to_ascii_lowercase();
                    if lk == "key"
                        || lk == "signature"
                        || lk.ends_with("_port")
                        || lk == "shell_port"
                        || lk == "iopub_port"
                        || lk == "stdin_port"
                        || lk == "control_port"
                        || lk == "hb_port"
                    {
                        return true;
                    }
                    if walk(val) {
                        return true;
                    }
                }
                false
            }
            Value::Array(arr) => arr.iter().any(walk),
            Value::String(s) => {
                // Heuristic: long hex keys (64 hex) alone are not enough; look for connection-file-like dumps.
                s.contains("\"shell_port\"") && s.contains("\"key\"")
            }
            _ => false,
        }
    }
    walk(value)
}

/// Parent/msg_id correlation helper for tests and client filtering.
pub fn correlates(parent_msg_id: Option<&str>, expected: &str) -> bool {
    parent_msg_id == Some(expected)
}

/// Reject malformed connection transport.
pub fn validate_connection_public(ip: &str, transport: &str, signature_scheme: &str) -> Result<()> {
    anyhow::ensure!(
        ip == "127.0.0.1" || ip == "localhost",
        "Kernel must bind loopback only"
    );
    anyhow::ensure!(transport == "tcp", "Only tcp transport is supported");
    anyhow::ensure!(
        signature_scheme == "hmac-sha256",
        "Only hmac-sha256 signature scheme is supported"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hmac_round_trip_matches_python_fixture() {
        // Generated with Python hmac/hashlib over the same four strings.
        let key = b"test-key";
        let header = r#"{"msg_id":"abc","msg_type":"execute_request","username":"koma","session":"s1","date":"2020-01-01T00:00:00.000000Z","version":"5.3"}"#;
        let parent = "{}";
        let metadata = "{}";
        let content = r#"{"code":"1+1","silent":false,"store_history":true,"user_expressions":{},"allow_stdin":false,"stop_on_error":true}"#;
        let sig = sign_hex(key, header, parent, metadata, content);
        assert_eq!(
            sig,
            "d9207427307414203d472b31962be2397ef5be6cfaa471330b5768f29e7fb79a"
        );
    }

    #[test]
    fn encode_decode_round_trip() {
        let key = b"super-secret-key-material";
        let header = make_header("execute_request", "sess-1", "mid-1");
        let content = execute_request_content("print('hi')", false).unwrap();
        let frames = encode_frames(key, &header, &json!({}), &json!({}), &content, &[]).unwrap();
        assert_eq!(frames[0], DELIM);
        let msg = decode_frames(key, &frames).unwrap();
        assert_eq!(msg.msg_type(), Some("execute_request"));
        assert_eq!(
            msg.header.get("msg_id").and_then(Value::as_str),
            Some("mid-1")
        );
        assert_eq!(msg.content["code"], "print('hi')");
    }

    #[test]
    fn rejects_wrong_signature() {
        let key = b"correct-key";
        let header = make_header("kernel_info_request", "s", "m");
        let mut frames =
            encode_frames(key, &header, &json!({}), &json!({}), &json!({}), &[]).unwrap();
        // Tamper with signature frame.
        frames[1] = b"0000000000000000000000000000000000000000000000000000000000000000".to_vec();
        let err = decode_frames(key, &frames).unwrap_err();
        assert!(err.to_string().contains("signature"));
    }

    #[test]
    fn decode_strips_identity_prefix() {
        let key = b"k";
        let header = make_header("status", "s", "m");
        let mut frames = encode_frames(
            key,
            &header,
            &json!({}),
            &json!({}),
            &json!({"execution_state":"idle"}),
            &[],
        )
        .unwrap();
        frames.insert(0, b"identity-bytes".to_vec());
        let msg = decode_frames(key, &frames).unwrap();
        assert_eq!(msg.content["execution_state"], "idle");
    }

    #[test]
    fn parent_correlation_helper() {
        assert!(correlates(Some("abc"), "abc"));
        assert!(!correlates(Some("abc"), "xyz"));
        assert!(!correlates(None, "abc"));
    }

    #[test]
    fn execute_request_shape() {
        let c = execute_request_content("1+1", false).unwrap();
        assert_eq!(c["code"], "1+1");
        assert_eq!(c["allow_stdin"], false);
        assert_eq!(c["store_history"], true);
        assert_eq!(c["silent"], false);
    }

    #[test]
    fn scrub_detects_key_fields() {
        assert!(scrub_secrets(&json!({"key": "abc"})));
        assert!(scrub_secrets(&json!({"shell_port": 1234})));
        assert!(!scrub_secrets(
            &json!({"text": "hello", "execution_count": 1})
        ));
    }

    #[test]
    fn validate_loopback_only() {
        validate_connection_public("127.0.0.1", "tcp", "hmac-sha256").unwrap();
        assert!(validate_connection_public("0.0.0.0", "tcp", "hmac-sha256").is_err());
        assert!(validate_connection_public("127.0.0.1", "tcp", "hmac-sha512").is_err());
    }

    #[test]
    fn encode_execute_returns_msg_id() {
        let (id, frames) = encode_execute_request(b"key", "sess", "x=1", false).unwrap();
        assert!(!id.is_empty());
        let msg = decode_frames(b"key", &frames).unwrap();
        assert_eq!(
            msg.header.get("msg_id").and_then(Value::as_str),
            Some(id.as_str())
        );
        assert_eq!(msg.msg_type(), Some("execute_request"));
    }
}
