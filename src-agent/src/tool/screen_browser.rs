//! On-screen browser tools: descriptions only here. Execution needs the daemon's
//! Main-session deferred dispatcher and an explicitly enabled local GUI owner.
use super::{Tool, ToolCtx};
use serde_json::{json, Value};

pub struct ScreenBrowser(pub &'static str);

impl Tool for ScreenBrowser {
    fn name(&self) -> &'static str {
        self.0
    }

    fn description(&self) -> &'static str {
        match self.0 {
            "screen_browser_tabs" => {
                "Manage tabs in this session's on-screen browser (system webview window). Actions: open, list, navigate, close, select, reload, stop, back, forward. Requires On-screen browser enabled in the local GUI (Globe control or Settings). Not Playwright headless browser_*; separate surface for human-in-the-loop web work. URLs must be http(s) or about:blank."
            }
            "screen_browser_observe" => {
                "Capture a screenshot of an on-screen browser tab and attach it. Returns observation_id for screen_browser_act. The user's live window is separate from this model observation. Frames are capped at 1920px/edge and ~2MP. Call after navigate, act, or human handoff."
            }
            "screen_browser_act" => {
                "Run up to 16 ordered inputs against the current on-screen browser observation (click, dblclick, hover, scroll, type, key, drag, wait). Prefer CSS selectors; coordinates are image pixels of the last observation. Enabling On-screen browser grants consent until pause/stop; no per-action workspace approval. Do not use when paused—call wait_human or ask the user to give control. observation must be the exact observation_id from screen_browser_observe."
            }
            "screen_browser_read" => {
                "Read structured data from the active (or specified) on-screen browser tab. Modes: markdown, text, html, query, actions_inventory. Bounded output. Prefer this over eval for extraction."
            }
            "screen_browser_eval" => {
                "Evaluate JavaScript in an on-screen browser tab. Requires Settings → On-screen browser → Allow page evaluate. Prefer read/act. Returns JSON-serializable result text."
            }
            _ => {
                "Pause the on-screen browser and wait for the human to finish a step (login, CAPTCHA, 2FA). Returns when they continue from the browser banner or Settings. Sharing stays on; observe after continue."
            }
        }
    }

    fn parameters(&self) -> Value {
        match self.0 {
            "screen_browser_tabs" => json!({
                "type": "object",
                "properties": {
                    "action": {"type":"string","enum":["open","list","navigate","close","select","reload","stop","back","forward"]},
                    "url": {"type":"string","description":"http(s) URL for open/navigate"},
                    "tab_id": {"type":"string"}
                },
                "required": ["action"],
                "additionalProperties": false
            }),
            "screen_browser_observe" => json!({
                "type": "object",
                "properties": {
                    "tab_id": {"type":"string"},
                    "full_page": {"type":"boolean","default":false}
                },
                "additionalProperties": false
            }),
            "screen_browser_act" => json!({
                "type":"object",
                "properties":{
                    "observation":{"type":"string","description":"Exact observation_id from screen_browser_observe"},
                    "tab_id":{"type":"string"},
                    "observe":{"type":"boolean","default":true},
                    "actions":{"type":"array","minItems":1,"maxItems":16,"items":{"oneOf":[
                        {"type":"object","properties":{"kind":{"const":"click"},"selector":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"button":{"enum":["left","right","double"]}},"required":["kind"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"dblclick"},"selector":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}},"required":["kind"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"hover"},"selector":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"}},"required":["kind"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"scroll"},"selector":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"delta":{"type":"integer"},"to":{"type":"string"}},"required":["kind"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"type"},"text":{"type":"string","maxLength":8192},"selector":{"type":"string"}},"required":["kind","text"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"key"},"keys":{"type":"array","minItems":1,"maxItems":5,"items":{"type":"string"}}},"required":["kind","keys"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"drag"},"selector":{"type":"string"},"x":{"type":"number"},"y":{"type":"number"},"to_selector":{"type":"string"},"to_x":{"type":"number"},"to_y":{"type":"number"}},"required":["kind"],"additionalProperties":false},
                        {"type":"object","properties":{"kind":{"const":"wait"},"selector":{"type":"string"},"url_contains":{"type":"string"},"timeout_ms":{"type":"integer","minimum":0,"maximum":120000}},"required":["kind"],"additionalProperties":false}
                    ]}}
                },
                "required":["observation","actions"],
                "additionalProperties":false
            }),
            "screen_browser_read" => json!({
                "type":"object",
                "properties":{
                    "tab_id":{"type":"string"},
                    "mode":{"type":"string","enum":["markdown","text","html","query","actions_inventory"]},
                    "selector":{"type":"string"},
                    "max_chars":{"type":"integer","minimum":1,"maximum":80000}
                },
                "required":["mode"],
                "additionalProperties":false
            }),
            "screen_browser_eval" => json!({
                "type":"object",
                "properties":{
                    "tab_id":{"type":"string"},
                    "script":{"type":"string","maxLength":100000},
                    "timeout_ms":{"type":"integer","minimum":1,"maximum":120000}
                },
                "required":["script"],
                "additionalProperties":false
            }),
            _ => json!({
                "type":"object",
                "properties":{
                    "message":{"type":"string","maxLength":2000}
                },
                "additionalProperties":false
            }),
        }
    }

    fn run(&self, _: &ToolCtx, _: &Value) -> anyhow::Result<String> {
        anyhow::bail!(
            "on-screen browser tools require the Main model's local GUI controller; TUI, headless, remote and delegated execution are unavailable"
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn screen_browser_tools_use_gui_consent() {
        for name in [
            "screen_browser_tabs",
            "screen_browser_observe",
            "screen_browser_act",
            "screen_browser_read",
            "screen_browser_eval",
            "screen_browser_wait_human",
        ] {
            assert!(!crate::tool::tool_is_risky(name));
            assert!(crate::tool::tool_allowed_in_plan(name));
            assert!(crate::tool::tool_allowed_in_sdlc_assess(name));
            assert!(!crate::tool::delegated_tool_allowed_in_plan(name));
        }
        assert!(!crate::tool::agent_selectable_tools()
            .iter()
            .any(|n| n.starts_with("screen_browser_")));
        assert!(crate::tool::DEFERRED_TOOLS.contains(&"screen_browser_act"));
        assert!(crate::tool::DEFERRED_TOOLS.contains(&"screen_browser_observe"));
    }
}
