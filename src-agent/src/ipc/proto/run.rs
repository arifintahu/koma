//! Credential-free, daemon-authoritative state for `koma run` setup and inspection.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct RunState {
    pub session_id: String,
    /// Live daemon session policy; absent on older daemons.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy: Option<crate::ipc::proto::turn::SessionPolicy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<crate::ipc::proto::TurnRecord>,
    pub name: String,
    pub workdir: Vec<String>,
    pub model: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub model_routes: Vec<crate::app::resolve::RoleResolution>,
    pub effort: String,
    pub mode: String,
    pub working: bool,
    pub awaiting_approval: bool,
    pub security_enabled: bool,
    pub security_running: bool,
    pub yolo_armed: bool,
    pub short_send: bool,
    pub drss_active: bool,
    pub max_output_tokens: u32,
    pub context_window_limit: u64,
    pub context_model_alias: String,
    /// True when `--system` / `--system-file` text is stored on this session.
    #[serde(default)]
    pub system_extra: bool,
    pub extensions: Vec<RunExtension>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RunExtension {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub activation: String,
    pub enabled: bool,
    pub active: bool,
    pub running: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc::proto::turn::{ApprovalPolicy, PlanPolicy, SessionPolicy};

    #[test]
    fn run_state_policy_is_optional_and_roundtrips() {
        let legacy = serde_json::to_value(RunState::default()).unwrap();
        assert!(legacy.get("policy").is_none());
        let mut state: RunState = serde_json::from_value(legacy).unwrap();
        assert_eq!(state.policy, None);
        state.policy = Some(SessionPolicy {
            plan: PlanPolicy::Forbid,
            approval: ApprovalPolicy::Reject,
        });
        let value = serde_json::to_value(&state).unwrap();
        assert_eq!(value["policy"], serde_json::json!({"plan": "forbid", "approval": "reject"}));
        assert_eq!(serde_json::from_value::<RunState>(value).unwrap(), state);
    }
}
