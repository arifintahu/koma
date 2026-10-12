use super::core::DaemonHub;
use crate::{
    app::{
        runtime::screen_browser::{self, Control},
        state::AppState,
    },
    ipc::proto::DaemonEvent,
};

impl DaemonHub {
    pub(super) fn screen_browser(&mut self, idx: usize, state: &mut AppState, control: Control) {
        let owner = self.clients[idx].id;
        if !cfg!(feature = "gui") || !self.clients[idx].attached {
            self.send_to(
                idx,
                DaemonEvent::Error("On-screen browser requires an attached local GUI".into()),
            );
            return;
        }
        let rt = state.rest.fg_mut();
        match control {
            Control::Enable {
                capabilities,
                prefs,
            } => {
                if let Err(e) = rt.screen_browser.enable(owner, &rt.id, capabilities, prefs) {
                    self.send_to(
                        idx,
                        DaemonEvent::ScreenBrowserStatus(screen_browser::Status {
                            session: rt.id.clone(),
                            message: e.to_string(),
                            ..Default::default()
                        }),
                    );
                }
            }
            Control::Result(reply) => screen_browser::bridge::receive(rt, owner, *reply),
            Control::WindowState {
                window_open,
                tabs,
                active_tab,
            } => {
                if rt.screen_browser.owner == Some(owner) {
                    rt.screen_browser
                        .apply_window_state(window_open, tabs, active_tab);
                }
            }
            other if rt.screen_browser.owner == Some(owner) => match other {
                Control::Pause => {
                    if let Some(id) = rt.screen_browser.pause(true, false) {
                        screen_browser::bridge::settle(
                            rt,
                            id,
                            "cancelled; on-screen browser paused".into(),
                        );
                    }
                }
                Control::TakeOver => {
                    if let Some(id) = rt.screen_browser.pause(true, true) {
                        screen_browser::bridge::settle(
                            rt,
                            id,
                            "cancelled; you took control of the on-screen browser".into(),
                        );
                    }
                }
                Control::Resume => {
                    if let Some(id) = rt.screen_browser.pause(false, false) {
                        screen_browser::bridge::settle(
                            rt,
                            id,
                            "cancelled; resumed — observe before acting".into(),
                        );
                    }
                }
                Control::Stop => screen_browser::bridge::stop(rt, "Stopped; reactivate explicitly"),
                Control::ContinueHuman => {
                    if let Some(id) = rt.screen_browser.continue_human() {
                        screen_browser::bridge::finish_wait_human(rt, id);
                    }
                }
                Control::OpenWindow => {
                    // GUI opens the window when it sees status.enabled; this just
                    // re-pushes status so the host ensures the window.
                    rt.screen_browser.status.message = "Open browser window".into();
                    rt.screen_browser.changed = true;
                }
                Control::ClearData => {
                    rt.screen_browser.status.generation = uuid::Uuid::new_v4().to_string();
                    rt.screen_browser.actionable = false;
                    rt.screen_browser.status.observation = None;
                    rt.screen_browser.status.tabs.clear();
                    rt.screen_browser.status.active_tab = None;
                    rt.screen_browser.status.message =
                        "Clear browsing data requested; GUI will wipe the profile".into();
                    rt.screen_browser.changed = true;
                    // Forward as a synthetic outbound via message field; GUI watches clear flag
                    // through prefs generation bump + message.
                }
                Control::SetPrefs { prefs } => {
                    rt.screen_browser.set_prefs(prefs);
                }
                _ => {}
            },
            _ => self.send_to(
                idx,
                DaemonEvent::Error("on-screen browser ownership mismatch".into()),
            ),
        }
    }

    pub(in crate::app::runtime::event_loop::daemon) fn drain_screen_browser(
        &mut self,
        state: &mut AppState,
    ) {
        for rt in &mut state.rest.sessions {
            if rt.screen_browser.expired() {
                if let Some((req, _)) = rt.screen_browser.pending.take() {
                    rt.screen_browser.status.busy = false;
                    rt.screen_browser.changed = true;
                    screen_browser::bridge::settle(
                        rt,
                        req.id,
                        serde_json::json!({
                            "error": "On-screen browser operation timed out",
                            "completed": 0,
                            "uncertain": true,
                            "controller_enabled": rt.screen_browser.status.enabled
                        })
                        .to_string(),
                    );
                }
            }
            if rt.closed && rt.screen_browser.status.enabled {
                screen_browser::bridge::stop(rt, "Session closed");
            }
            if rt
                .screen_browser
                .owner
                .is_some_and(|owner| self.clients.iter().all(|c| c.id != owner))
            {
                screen_browser::bridge::gui_client_lost(rt);
            }
            let Some(owner) = rt.screen_browser.owner else {
                continue;
            };
            let Some(idx) = self.clients.iter().position(|c| c.id == owner) else {
                continue;
            };
            if self.clients[idx].foreground.as_deref() != Some(rt.id.as_str()) {
                screen_browser::bridge::stop(rt, "Session switched");
            }
            if rt.screen_browser.changed {
                self.send_to(
                    idx,
                    DaemonEvent::ScreenBrowserStatus(rt.screen_browser.status.clone()),
                );
                rt.screen_browser.changed = false;
            }
            if let Some(request) = rt.screen_browser.take_outbound() {
                self.send_to(idx, DaemonEvent::ScreenBrowserOperation(request));
            }
            if !rt.screen_browser.status.enabled {
                rt.screen_browser.owner = None;
            }
        }
    }
}
