//! Selected-session reducer. A sequence gap invalidates deltas until a full snapshot.
use super::protocol::{Approval, Gate, Message, PendingApproval, Plan, Policy, State, Turn};
use crate::ipc::proto::{DaemonEvent, DaemonFrame, SessionSnapshot, StateDelta, TurnState};

pub struct Reconcile {
    pub id: String,
    pub session: Option<SessionSnapshot>,
    pub policy: Option<Policy>,
    last: Option<u64>,
    pub syncing: bool,
    pub external_approvals: bool,
    revision: u64,
    resync: u64,
    previous: Option<State>,
}
impl Reconcile {
    pub fn new(id: String) -> Self {
        Self {
            id,
            session: None,
            policy: None,
            last: None,
            syncing: false,
            external_approvals: false,
            revision: 0,
            resync: 0,
            previous: None,
        }
    }
    /// Returns true exactly when a new resync request is needed.
    pub fn apply(&mut self, f: &DaemonFrame) -> bool {
        let gap = self.last.is_some_and(|n| f.seq != n + 1);
        self.last = Some(f.seq);
        let request = gap && !self.syncing;
        if gap {
            self.syncing = true;
        }
        if let DaemonEvent::Snapshot(s) = &f.event {
            if self.syncing {
                self.resync += 1;
            }
            self.session = s.sessions.iter().find(|s| s.id == self.id).cloned();
            self.syncing = false;
            return false;
        }
        if self.syncing {
            return request;
        }
        if let (Some(s), DaemonEvent::Delta(d)) = (&mut self.session, &f.event) {
            match d {
                StateDelta::TokenAppended { session_id, text } if session_id == &self.id => {
                    s.streaming.get_or_insert_with(String::new).push_str(text)
                }
                StateDelta::SessionStatusChanged {
                    session_id,
                    working,
                    ..
                } if session_id == &self.id => s.working = *working,
                StateDelta::SessionAdded(snap) if snap.id == self.id => *s = *snap.clone(),
                _ => {}
            }
        }
        false
    }
    pub fn state(&mut self) -> Option<State> {
        if self.syncing {
            return None;
        }
        let s = self.session.as_ref()?;
        let call = s.pending_tool_calls.get(s.tool_idx);
        let kind = if !s.awaiting_approval {
            None
        } else {
            Some(match call.map(|c| c.function.name.as_str()) {
                Some("plan_ready") => "plan",
                Some("mission_ready") => "mission",
                Some(_) if call.is_some_and(|c| !c.id.is_empty()) => "tool",
                _ => "unknown",
            })
        };
        let pending_approval = if kind == Some("tool") {
            call.map(|c| PendingApproval {
                call_id: c.id.clone(),
                reason: s.approval_reason.clone(),
            })
        } else {
            None
        };
        let gate = kind.map(|kind| Gate {
            kind,
            reason: s.approval_reason.clone(),
            supported: kind == "tool" && self.external_approvals,
        });
        let mut state = State {
            revision: self.revision,
            external_approvals: self.external_approvals,
            pending_approval,
            gate,
            resync: self.resync,
            session_id: s.id.clone(),
            cwd: s.cwd.clone(),
            model_id: s.resolved_model_id.clone(),
            policy: self.policy.clone()?,
            turn: s.turn.as_ref().map(|t| Turn {
                id: t.id.clone(),
                state: match t.state {
                    TurnState::Running => "running",
                    TurnState::Finished => "finished",
                    TurnState::Interrupted => "interrupted",
                    TurnState::Failed => "failed",
                },
                error: t.error.clone(),
            }),
            working: s.working,
            awaiting_approval: s.awaiting_approval,
            approval_reason: s.approval_reason.clone(),
            pending_count: s.pending_steer.len(),
            messages: s
                .messages
                .iter()
                .map(|m| Message {
                    role: match m.role {
                        crate::dto::chat::Role::System => "system",
                        crate::dto::chat::Role::User => "user",
                        crate::dto::chat::Role::Assistant => "assistant",
                        crate::dto::chat::Role::Tool => "tool",
                    },
                    content: m.content.clone(),
                })
                .collect(),
            streaming: s.streaming.clone(),
        };
        if self.previous.as_ref() != Some(&state) {
            self.revision += 1;
            state.revision = self.revision;
            self.previous = Some(state.clone());
        }
        Some(state)
    }
    pub fn readback(&mut self, s: &crate::ipc::proto::RunState) -> anyhow::Result<()> {
        anyhow::ensure!(s.session_id == self.id, "daemon returned another session");
        let p = s
            .policy
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("daemon omitted policy readback"))?;
        self.policy = Some(Policy {
            plan: match p.plan {
                crate::ipc::proto::PlanPolicy::Allow => Plan::Allow,
                crate::ipc::proto::PlanPolicy::Forbid => Plan::Forbid,
            },
            approval: match p.approval {
                crate::ipc::proto::ApprovalPolicy::Default => Approval::Default,
                crate::ipc::proto::ApprovalPolicy::Reject => Approval::Reject,
            },
        });
        // RunState confirms policy only. Turn/output/gate fields must remain from
        // the same selected-session snapshot until an authoritative update arrives.
        Ok(())
    }
}
