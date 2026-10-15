//! Inbound response types for the OpenRouter chat-completions API.
//!
//! Covers both non-streaming (full-body) responses used by `/compact` and
//! per-SSE-frame streaming chunks used by normal chat turns.

use super::usage::Usage;
use serde::Deserialize;

// ---------------------------------------------------------------------------
// Non-streaming response (used by /compact summary)
// ---------------------------------------------------------------------------

/// Top-level non-streaming response envelope.
///
/// OpenRouter returns an array of `choices`; we always take `choices[0]`.
#[derive(Debug, Deserialize)]
pub struct ChatResponse {
    pub choices: Vec<Choice>,
    /// Token/cost accounting (present when the request asked for it). Unused by
    /// the compaction caller today, kept for completeness with the streaming path.
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// One completion alternative inside a non-streaming response.
#[derive(Debug, Deserialize)]
pub struct Choice {
    #[serde(default)]
    pub finish_reason: Option<String>,
    pub message: ResponseMessage,
}

/// The finished message inside a non-streaming `Choice`.
///
/// `role` is received as a string (e.g. `"assistant"`) but is unused by the
/// caller; only `content` is extracted for the compaction summary.
///
/// `content` is `Option<String>` because some models (e.g. deepseek-v4-flash)
/// return `"content": null` on a non-streaming response instead of an empty
/// string. `#[serde(default)]` additionally handles an absent field. Callers
/// use `.unwrap_or_default()` to treat null/absent as an empty final answer.
///
/// `reasoning` carries a reasoning model's thinking text: some models (e.g. the
/// safeguard classifier) can leave `content` empty while this field is populated.
/// It is never used as a classifier decision. Defaults to `None` when absent.
#[derive(Debug, Deserialize)]
#[serde(from = "ResponseMessageDe")]
pub struct ResponseMessage {
    #[allow(dead_code)]
    pub role: String,
    #[serde(default)]
    pub content: Option<String>,
    /// Thinking text. Populated from `reasoning`, `reasoning_content`, or
    /// `thinking`. A serde alias cannot be used: mlx-vlm sends the same fragment
    /// under both `reasoning` and `reasoning_content`, and serde rejects that as
    /// a duplicate field, which drops the whole message.
    #[allow(dead_code)] // Retained in the response DTO; never used as archive evidence.
    pub reasoning: Option<String>,
    /// OpenRouter `reasoning_details` array on a non-streaming assistant message.
    /// Captured verbatim so a reasoning model's chain-of-thought (incl. load-bearing
    /// signatures) can be echoed back on tool-continuation requests. `None` on
    /// providers/models that don't emit it. The non-streaming path (`/compact`
    /// summary) has no tool round-trip to replay it on, so it is decoded but not
    /// read today — mirrors the sibling `role` field.
    #[allow(dead_code)]
    #[serde(default)]
    pub reasoning_details: Option<Vec<crate::dto::chat::ReasoningDetail>>,
}

// ---------------------------------------------------------------------------
// Streaming chunk (one SSE data: line)
// ---------------------------------------------------------------------------

/// One parsed SSE `data:` frame received during a streaming chat turn.
///
/// Most frames carry a one-element `choices` array whose `Delta::content` is
/// appended to the assistant bubble. The FINAL frame instead carries `usage`
/// (token counts + cost) with an empty `choices` array, so both fields are
/// handled independently.
#[derive(Debug, Deserialize)]
pub struct StreamChunk {
    pub choices: Vec<StreamChoice>,
    /// Present only on the terminal chunk: token/cost accounting for the whole
    /// generation. Absent (`None`) on every content-bearing chunk.
    #[serde(default)]
    pub usage: Option<Usage>,
}

/// The single choice inside a streaming chunk.
#[derive(Debug, Deserialize)]
pub struct StreamChoice {
    pub delta: Delta,
    /// Set on the final content frame for this choice: `"stop"`, `"tool_calls"`,
    /// `"length"`, etc. Absent on intermediate frames. Defaults to `None`.
    #[serde(default)]
    pub finish_reason: Option<String>,
}

/// Incremental content fragment for the current assistant turn.
///
/// `content` is `None` on the first and last frames (role-only / finish-reason
/// frames); callers should skip `None` values and append `Some(text)` to the
/// growing assistant bubble. `tool_calls` carries incremental function-call
/// deltas (id / name / argument fragments) that the caller accumulates by index.
#[derive(Debug, Deserialize)]
#[serde(from = "DeltaDe")]
pub struct Delta {
    #[serde(default)]
    pub content: Option<String>,
    /// Incremental reasoning/thinking fragment for the current assistant turn,
    /// streamed in a SEPARATE channel from `content` when reasoning is enabled
    /// (via `/effort`). Accumulated into the assistant message's display-only
    /// reasoning block; never echoed back to the API. `None` on frames the model
    /// doesn't think on (and absent entirely for non-reasoning models).
    ///
    /// Filled from `reasoning`, `reasoning_content`, or `thinking`, including
    /// when a backend sends more than one of those keys on the same object.
    pub reasoning: Option<String>,
    /// Incremental OpenRouter `reasoning_details` fragments for the current
    /// assistant turn, streamed in chunks carrying an `index`. Merged (by index)
    /// into the assistant message's reasoning_details and echoed back on
    /// tool-continuation requests so the model keeps its chain-of-thought (incl.
    /// load-bearing signatures) across tool calls. `None` on frames/models without it.
    #[serde(default)]
    pub reasoning_details: Option<Vec<crate::dto::chat::ReasoningDetail>>,
    /// Incremental tool-call fragments. The model streams a tool call across
    /// several frames: the first carries the `id` + function `name`, subsequent
    /// frames append `arguments` text. Each entry's `index` selects the slot to
    /// merge into.
    #[serde(default)]
    pub tool_calls: Option<Vec<ToolCallDelta>>,
}

/// One streamed fragment of a tool call. `index` identifies which tool call in
/// the assistant turn this fragment belongs to (the model may stream several in
/// parallel). It is `None` when a provider OMITS the field on a frame — kept
/// distinct from an explicit `Some(0)` so an argument-only continuation is merged
/// into the call already in progress instead of being misrouted to slot 0 (which
/// manufactured phantom empty-argument calls). `id` and `function.name` arrive
/// once; `function.arguments` is the fragment to append to that call's growing
/// argument string. `apply_tool_call_delta` performs the merge.
#[derive(Debug, Clone, Deserialize)]
pub struct ToolCallDelta {
    pub index: Option<usize>,
    pub id: Option<String>,
    pub function: Option<FunctionDelta>,
}

/// The `function` slice of a [`ToolCallDelta`]: either the call's `name` (sent
/// on the first fragment) or a chunk of its JSON-encoded `arguments` string.
#[derive(Debug, Clone, Deserialize)]
pub struct FunctionDelta {
    pub name: Option<String>,
    pub arguments: Option<String>,
}

/// First non-empty thinking channel. Backends disagree on the key name, and
/// mlx-vlm emits the same text under two of them at once.
fn coalesce_reasoning(
    reasoning: Option<String>,
    reasoning_content: Option<String>,
    thinking: Option<String>,
) -> Option<String> {
    [reasoning, reasoning_content, thinking]
        .into_iter()
        .find(|text| matches!(text, Some(value) if !value.is_empty()))
        .flatten()
}

#[derive(Deserialize)]
struct ResponseMessageDe {
    role: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    reasoning_details: Option<Vec<crate::dto::chat::ReasoningDetail>>,
}

impl From<ResponseMessageDe> for ResponseMessage {
    fn from(raw: ResponseMessageDe) -> Self {
        Self {
            role: raw.role,
            content: raw.content,
            reasoning: coalesce_reasoning(raw.reasoning, raw.reasoning_content, raw.thinking),
            reasoning_details: raw.reasoning_details,
        }
    }
}

#[derive(Deserialize)]
struct DeltaDe {
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    reasoning_content: Option<String>,
    #[serde(default)]
    thinking: Option<String>,
    #[serde(default)]
    reasoning_details: Option<Vec<crate::dto::chat::ReasoningDetail>>,
    #[serde(default)]
    tool_calls: Option<Vec<ToolCallDelta>>,
}

impl From<DeltaDe> for Delta {
    fn from(raw: DeltaDe) -> Self {
        Self {
            content: raw.content,
            reasoning: coalesce_reasoning(raw.reasoning, raw.reasoning_content, raw.thinking),
            reasoning_details: raw.reasoning_details,
            tool_calls: raw.tool_calls,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::StreamChunk;

    #[test]
    fn mlx_duplicate_reasoning_keys_keep_content() {
        let raw = r#"{
            "choices": [{
                "delta": {
                    "role": "assistant",
                    "content": "Online.",
                    "reasoning": "hi",
                    "reasoning_content": "hi",
                    "tool_calls": null,
                    "tool_call_id": null,
                    "name": null
                }
            }]
        }"#;
        let chunk: StreamChunk = serde_json::from_str(raw).expect("both reasoning keys");
        let delta = &chunk.choices[0].delta;
        assert_eq!(delta.content.as_deref(), Some("Online."));
        assert_eq!(delta.reasoning.as_deref(), Some("hi"));
    }

    #[test]
    fn reasoning_content_alone_still_maps() {
        let raw = r#"{"choices":[{"delta":{"content":null,"reasoning_content":"The"}}]}"#;
        let chunk: StreamChunk = serde_json::from_str(raw).unwrap();
        let delta = &chunk.choices[0].delta;
        assert_eq!(delta.content, None);
        assert_eq!(delta.reasoning.as_deref(), Some("The"));
    }
}
