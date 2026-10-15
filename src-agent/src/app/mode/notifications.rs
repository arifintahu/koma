use crate::model::notifications::{Entry, Operation, Reply, Request};
use serde::{Deserialize, Serialize};
use std::sync::{mpsc::Receiver, Arc, Mutex};
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationsState {
    #[serde(default)]
    pub loading: bool,
    pub session: Option<String>,
    pub app: bool,
    pub query: String,
    #[serde(default)]
    pub severity: Option<String>,
    pub cursor: usize,
    pub expanded: Option<String>,
    pub confirm_clear: bool,
    pub entries: Vec<Entry>,
    pub error: Option<String>,
    #[serde(skip)]
    pub refreshed: Option<std::time::Instant>,
    #[serde(skip)]
    pub pending: Option<Arc<Mutex<Receiver<Reply>>>>,
}
impl PartialEq for NotificationsState {
    fn eq(&self, o: &Self) -> bool {
        self.loading == o.loading
            && self.session == o.session
            && self.app == o.app
            && self.query == o.query
            && self.severity == o.severity
            && self.cursor == o.cursor
            && self.expanded == o.expanded
            && self.confirm_clear == o.confirm_clear
            && self.entries == o.entries
            && self.error == o.error
    }
}
impl NotificationsState {
    pub fn new(session: Option<String>) -> Self {
        let mut s = Self {
            loading: false,
            app: session.is_none(),
            session,
            query: String::new(),
            severity: None,
            cursor: 0,
            expanded: None,
            confirm_clear: false,
            entries: vec![],
            error: None,
            pending: None,
            refreshed: None,
        };
        s.request(Operation::List);
        s
    }
    pub fn request(&mut self, operation: Operation) {
        self.loading = true;
        self.pending = Some(Arc::new(Mutex::new(crate::model::notifications::request(
            Request {
                id: uuid::Uuid::new_v4().to_string(),
                session: if self.app { None } else { self.session.clone() },
                operation,
            },
        ))));
    }
    pub fn poll(&mut self) -> bool {
        if self.pending.is_none() && self.refreshed.is_none_or(|t| t.elapsed().as_secs() >= 2) {
            self.request(Operation::List);
        }
        let reply = self
            .pending
            .as_ref()
            .and_then(|rx| rx.lock().ok()?.try_recv().ok());
        if let Some(reply) = reply {
            let selected = self.filtered().get(self.cursor).map(|e| e.id.clone());
            if reply.error.is_none() {
                self.entries = reply.entries;
                if let Some(id) = selected {
                    self.cursor = self
                        .filtered()
                        .iter()
                        .position(|e| e.id == id)
                        .unwrap_or(self.cursor);
                }
            }
            self.error = reply.error;
            self.pending = None;
            self.loading = false;
            self.refreshed = Some(std::time::Instant::now());
            self.cursor = self.cursor.min(self.filtered().len().saturating_sub(1));
            true
        } else {
            false
        }
    }
    pub fn filtered(&self) -> Vec<&Entry> {
        let q = self.query.to_lowercase();
        self.entries
            .iter()
            .filter(|e| {
                self.severity
                    .as_ref()
                    .is_none_or(|severity| severity == &e.severity)
                    && format!("{} {} {}", e.message, e.source, e.severity)
                        .to_lowercase()
                        .contains(&q)
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_and_keyboard_search_preserve_history() {
        use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
        let mut state = NotificationsState {
            loading: false,
            session: Some("test-session".into()),
            app: false,
            query: String::new(),
            severity: None,
            cursor: 0,
            expanded: Some("entry".into()),
            confirm_clear: false,
            entries: vec![
                Entry::new("Alpha notice".into(), "info", "runtime"),
                Entry::new("Beta error".into(), "error", "test"),
            ],
            error: None,
            pending: None,
            refreshed: None,
        };
        let wire = serde_json::to_string(&crate::ipc::proto::ModeSnapshot::Notifications(
            Box::new(state.clone()),
        ))
        .unwrap();
        assert!(!wire.contains("pending"));
        let restored: crate::ipc::proto::ModeSnapshot = serde_json::from_str(&wire).unwrap();
        assert_eq!(
            restored,
            crate::ipc::proto::ModeSnapshot::Notifications(Box::new(state.clone()))
        );
        crate::controller::input::notifications::handle(
            &mut state,
            KeyEvent::new(KeyCode::Down, KeyModifiers::NONE),
        );
        assert_eq!(state.cursor, 1);
        crate::controller::input::notifications::handle(
            &mut state,
            KeyEvent::new(KeyCode::Char('b'), KeyModifiers::NONE),
        );
        assert_eq!(state.cursor, 0);
        assert_eq!(state.filtered().len(), 1);
        let action = crate::controller::input::notifications::handle(
            &mut state,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
        );
        assert!(matches!(
            action,
            crate::controller::input::Action::CloseHelp
        ));
        assert_eq!(state.entries.len(), 2);
        state.query.clear();
        crate::controller::input::notifications::handle(
            &mut state,
            KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL),
        );
        assert_eq!(state.severity.as_deref(), Some("info"));
        assert_eq!(state.filtered().len(), 1);
        assert_eq!(state.filtered()[0].message, "Alpha notice");
        for _ in 0..3 {
            crate::controller::input::notifications::handle(
                &mut state,
                KeyEvent::new(KeyCode::Char('f'), KeyModifiers::CONTROL),
            );
        }
        assert_eq!(state.severity.as_deref(), Some("error"));
        assert_eq!(state.filtered()[0].message, "Beta error");
        let mut legacy = serde_json::to_value(&state).unwrap();
        legacy.as_object_mut().unwrap().remove("severity");
        assert!(serde_json::from_value::<NotificationsState>(legacy)
            .unwrap()
            .severity
            .is_none());
        state.query.clear();
        state.severity = None;
        state.cursor = 1;
        let selected = state.filtered()[1].id.clone();
        let mut reordered = state.entries.clone();
        reordered.reverse();
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Reply {
            id: "refresh".into(),
            session: state.session.clone(),
            entries: reordered,
            error: None,
        })
        .unwrap();
        state.pending = Some(Arc::new(Mutex::new(rx)));
        assert!(state.poll());
        assert_eq!(state.filtered()[state.cursor].id, selected);
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(Reply {
            id: "failure".into(),
            session: state.session.clone(),
            entries: vec![],
            error: Some("service failure".into()),
        })
        .unwrap();
        state.pending = Some(Arc::new(Mutex::new(rx)));
        assert!(state.poll());
        assert_eq!(state.error.as_deref(), Some("service failure"));
        assert_eq!(state.entries.len(), 2);
        state.confirm_clear = true;
        crate::controller::input::notifications::handle(
            &mut state,
            KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE),
        );
        assert!(!state.confirm_clear);

        assert!(matches!(
            crate::controller::command::parse("/notification"),
            crate::controller::command::Command::Notification
        ));
    }
}
