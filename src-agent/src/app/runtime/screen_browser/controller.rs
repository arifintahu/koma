//! Daemon-side consent and operation correlation for the on-screen browser.
use super::*;
use anyhow::{bail, Result};
use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

#[derive(Default)]
pub struct Controller {
    pub owner: Option<u64>,
    pub status: Status,
    pub outbound: Option<Request>,
    pub pending: Option<(Request, Instant)>,
    pub changed: bool,
    pub actionable: bool,
    pub waiting_human_id: Option<String>,
    used: HashSet<String>,
}

impl Controller {
    pub fn enable(
        &mut self,
        owner: u64,
        session: &str,
        capabilities: Capabilities,
        prefs: Prefs,
    ) -> Result<()> {
        // Same owner, already on → idempotent (globe re-click / double enable).
        if self.status.enabled && self.owner == Some(owner) && self.status.session == session {
            self.status.message = "Ready".into();
            self.changed = true;
            return Ok(());
        }
        // Stale enabled from a previous client → take over after stop.
        if self.status.enabled {
            let _ = self.stop("Replaced by new enable");
        }
        self.owner = Some(owner);
        self.used.clear();
        self.waiting_human_id = None;
        self.actionable = false;
        self.status = Status {
            session: session.into(),
            generation: uuid::Uuid::new_v4().to_string(),
            enabled: true,
            paused: false,
            busy: false,
            waiting_human: false,
            window_open: false,
            always_on_top: prefs.always_on_top,
            capabilities,
            prefs,
            tabs: Vec::new(),
            active_tab: None,
            observation: None,
            message: "Ready; open the browser window".into(),
            waiting_message: None,
            blocked_nav: None,
        };
        self.changed = true;
        Ok(())
    }

    pub fn stop(&mut self, reason: &str) -> Option<String> {
        let pending = self.pending.take().map(|(r, _)| r.id);
        let waiting = self.waiting_human_id.take();
        self.outbound = None;
        self.status.enabled = false;
        self.status.paused = false;
        self.status.busy = false;
        self.status.waiting_human = false;
        self.status.waiting_message = None;
        self.status.window_open = false;
        self.status.tabs.clear();
        self.status.active_tab = None;
        self.status.observation = None;
        self.actionable = false;
        self.status.generation = uuid::Uuid::new_v4().to_string();
        self.status.message = reason.into();
        self.changed = true;
        self.owner = None;
        pending.or(waiting)
    }

    pub fn pause(&mut self, pause: bool, take_over: bool) -> Option<String> {
        let pending = self.pending.take().map(|(r, _)| r.id);
        self.outbound = None;
        self.status.paused = pause;
        self.status.busy = false;
        self.actionable = false;
        if pause {
            self.status.waiting_human = false;
            self.status.waiting_message = None;
            self.waiting_human_id = None;
        }
        self.status.generation = uuid::Uuid::new_v4().to_string();
        self.status.message = if pause {
            if take_over {
                "Paused; you have control"
            } else {
                "Paused"
            }
        } else {
            "Resumed; observe before acting"
        }
        .into();
        self.changed = true;
        pending
    }

    pub fn begin_wait_human(&mut self, id: String, message: Option<String>) -> Result<()> {
        self.ensure_active()?;
        if self.pending.is_some() || self.used.contains(&id) {
            bail!("duplicate or concurrent screen-browser request");
        }
        self.used.insert(id.clone());
        self.status.paused = true;
        self.status.waiting_human = true;
        self.status.waiting_message = Some(
            message
                .filter(|m| !m.trim().is_empty())
                .unwrap_or_else(|| "Waiting for you to continue".into()),
        );
        self.status.message = self
            .status
            .waiting_message
            .clone()
            .unwrap_or_else(|| "Waiting for you".into());
        self.status.busy = true;
        self.actionable = false;
        self.waiting_human_id = Some(id);
        self.status.generation = uuid::Uuid::new_v4().to_string();
        self.changed = true;
        Ok(())
    }

    pub fn continue_human(&mut self) -> Option<String> {
        let id = self.waiting_human_id.take()?;
        self.status.waiting_human = false;
        self.status.waiting_message = None;
        self.status.paused = false;
        self.status.busy = false;
        self.status.message = "Continued; observe before acting".into();
        self.status.generation = uuid::Uuid::new_v4().to_string();
        self.actionable = false;
        self.changed = true;
        Some(id)
    }

    pub fn set_prefs(&mut self, prefs: Prefs) {
        self.status.always_on_top = prefs.always_on_top;
        self.status.capabilities.eval = prefs.allow_eval;
        self.status.prefs = prefs;
        self.changed = true;
    }

    pub fn apply_window_state(
        &mut self,
        window_open: bool,
        tabs: Vec<TabInfo>,
        active_tab: Option<String>,
    ) {
        self.status.window_open = window_open;
        self.status.tabs = tabs;
        self.status.active_tab = active_tab;
        self.changed = true;
    }

    fn ensure_active(&self) -> Result<()> {
        if !self.status.enabled || self.owner.is_none() {
            bail!("no active local GUI on-screen browser; enable it from the Globe control or Settings → On-screen browser");
        }
        Ok(())
    }

    /// Queue an operation for the owning GUI. Pause blocks act/eval/tabs mutations
    /// from the agent except list/observe/read and wait_human (already paused).
    pub fn begin(&mut self, id: String, operation: Operation) -> Result<()> {
        self.ensure_active()?;
        if self.pending.is_some() || self.used.contains(&id) {
            bail!("duplicate or concurrent screen-browser request");
        }
        if self.status.waiting_human {
            bail!("waiting for human; continue from the browser banner or Settings");
        }
        let caps = &self.status.capabilities;
        let paused_blocks = self.status.paused
            && !matches!(
                &operation,
                Operation::Tabs { action, .. } if action == "list"
            )
            && !matches!(
                &operation,
                Operation::Observe { .. } | Operation::Read { .. } | Operation::WaitHuman { .. }
            );
        if paused_blocks {
            bail!("on-screen browser is paused; give control or resume first");
        }
        match &operation {
            Operation::Eval { .. } if !caps.eval || !self.status.prefs.allow_eval => {
                bail!("page evaluate is disabled; enable it in Settings → On-screen browser");
            }
            Operation::Observe { .. } if !caps.capture => bail!("capture unsupported"),
            Operation::Act {
                observation,
                actions,
                ..
            } => {
                if actions.is_empty() || actions.len() > ACT_MAX {
                    bail!("actions must contain 1..={ACT_MAX} items");
                }
                let current = self.status.observation.as_ref().ok_or_else(|| {
                    anyhow::anyhow!("No observation available; call screen_browser_observe first")
                })?;
                if current.id != *observation {
                    bail!("Stale observation: observe again and use the new observation_id");
                }
                if !self.actionable || current.generation != self.status.generation {
                    bail!("Stale observation: observe again and use the new observation_id");
                }
                if !caps.input {
                    bail!("input unsupported");
                }
            }
            Operation::Tabs { action, url, .. } => {
                match action.as_str() {
                    "open" | "navigate" => {
                        if let Some(u) = url {
                            validate_content_url(u)?;
                        } else if action == "navigate" {
                            bail!("url is required for navigate");
                        }
                    }
                    "list" | "close" | "select" | "reload" | "stop" | "back" | "forward" => {}
                    other => bail!("unknown tabs action: {other}"),
                }
                if self.status.tabs.len() >= MAX_TABS && action == "open" {
                    bail!("tab limit ({MAX_TABS}) reached; close a tab first");
                }
            }
            Operation::Read { mode, .. } => match mode.as_str() {
                "markdown" | "text" | "html" | "query" | "actions_inventory" => {}
                other => bail!("unknown read mode: {other}"),
            },
            Operation::WaitHuman { .. } => {}
            _ => {}
        }

        if matches!(operation, Operation::WaitHuman { .. }) {
            let message = match &operation {
                Operation::WaitHuman { message } => message.clone(),
                _ => None,
            };
            return self.begin_wait_human(id, message);
        }

        let request = Request {
            id: id.clone(),
            session: self.status.session.clone(),
            generation: self.status.generation.clone(),
            operation,
            observation: self.status.observation.clone(),
        };
        // list/read/observe don't permanently invalidate until settle decides
        if !matches!(
            request.operation,
            Operation::Tabs {
                action: ref a,
                ..
            } if a == "list"
        ) && !matches!(request.operation, Operation::Read { .. })
        {
            // observe refreshes actionable on success
            if !matches!(request.operation, Operation::Observe { .. }) {
                self.actionable = false;
            }
        }
        self.used.insert(id);
        self.pending = Some((request.clone(), Instant::now()));
        self.outbound = Some(request);
        self.status.busy = true;
        self.changed = true;
        Ok(())
    }

    pub fn accepts(&self, owner: u64, reply: &Reply) -> bool {
        self.owner == Some(owner)
            && self.status.enabled
            && self.pending.as_ref().is_some_and(|(r, _)| {
                r.id == reply.id && r.session == reply.session && r.generation == reply.generation
            })
    }

    pub fn expired(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|(_, t)| t.elapsed() > Duration::from_secs(120))
    }

    pub fn take_outbound(&mut self) -> Option<Request> {
        self.outbound.take()
    }

    pub fn settle_ok(&mut self, reply: Reply) {
        self.pending = None;
        self.status.busy = false;
        if let Some(obs) = reply.observation.clone() {
            self.status.observation = Some(obs);
            self.actionable = true;
        }
        if !reply.tabs.is_empty() {
            self.status.tabs = reply.tabs.clone();
            self.status.active_tab = reply
                .tabs
                .iter()
                .find(|t| t.active)
                .map(|t| t.id.clone())
                .or(self.status.active_tab.clone());
        }
        if let Some(err) = &reply.error {
            self.status.message = err.clone();
        } else {
            self.status.message = "Ready".into();
        }
        self.changed = true;
    }

    pub fn settle_err(&mut self, id: &str, error: String) {
        if self.pending.as_ref().is_some_and(|(r, _)| r.id == id) {
            self.pending = None;
        }
        self.status.busy = false;
        self.actionable = false;
        self.status.message = error;
        self.changed = true;
    }
}
