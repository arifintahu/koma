#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::app::mode::Mode;
use crate::app::state::SessionRuntime;
use crate::model::app_config::{ModelEntry, ModelRole, OAuthConn, OAuthProvider};
use crate::service::catalogue_overlay::{merge_detail, OverlayModel};
use crate::service::oauth::registry::COMMANDCODE_API_BASE;

fn session(id: &str, model: &str, effort: &str) -> SessionRuntime {
    let mut rt = SessionRuntime::new();
    rt.id = id.into();
    let mut settings = crate::model::settings::Settings::default();
    settings.effort = effort.into();
    settings.session_models.push(ModelEntry {
        uuid: id.into(),
        model_id: model.into(),
        provider_uuid: "cc-push".into(),
        roles: vec![ModelRole::Main],
        ..Default::default()
    });
    rt.session = Some(crate::model::session::Session::new(
        id.into(),
        Default::default(),
        "test".into(),
        settings,
        crate::model::conversation::Conversation::new(""),
    ));
    rt
}

#[test]
fn completion_push_brackets_matching_attached_clients_and_drops_stale_model() {
    let model = "effort-hub-ready-unique";
    let fixture: OverlayModel = serde_json::from_value(serde_json::json!({
        "id": model, "reasoning": { "supported_efforts": ["low", "high"] }
    }))
    .unwrap();
    merge_detail(COMMANDCODE_API_BASE, fixture);
    let mut state = AppState::new(Mode::Chat);
    state.rest.config.oauth_conns.push(OAuthConn {
        uuid: "cc-push".into(),
        provider: OAuthProvider::CommandCode,
        access_token: "test".into(),
        commandcode_chat: Some("ndjson".into()),
        ..Default::default()
    });
    state.rest.sessions = vec![
        session("a", model, "high"),
        session("b", model, "low"),
        session("stale", "changed-since-refresh", ""),
        session("unrelated", "unrelated-model", ""),
    ];
    state.rest.foreground = 3; // Stale rest.foreground MUST NOT drive any push.
    let (mut hub, _tx) = DaemonHub::new();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let mut client = None;
    let mut receivers = Vec::new();
    for (i, foreground, attached) in [
        (0, "a", true),
        (1, "b", true),
        (2, "a", false),
        (3, "stale", true),
        (4, "unrelated", true),
    ] {
        let (tx, rx) = std::sync::mpsc::channel();
        hub.handle_inbound(
            super::super::core::HubInbound::Register {
                client_id: i as u64,
                frame_tx: tx,
            },
            &mut state,
            &mut client,
            runtime.handle(),
        );
        hub.clients[i].foreground = Some(foreground.into());
        hub.clients[i].attached = attached;
        receivers.push(rx);
    }
    for id in ["a", "b", "stale"] {
        state
            .rest
            .effort_refresh_sessions
            .insert(id.into(), (COMMANDCODE_API_BASE.into(), model.into()));
    }
    hub.drain_effort_pushes(&mut state);
    assert_eq!(state.rest.foreground, 3);
    assert!(state.rest.effort_refresh_sessions.is_empty());
    for (i, selected) in [(0, 3), (1, 2)] {
        let frame = receivers[i].try_recv().unwrap();
        assert_eq!(frame.seq, 1);
        match frame.event {
            DaemonEvent::EffortOptions {
                state,
                options,
                selected: actual,
                ..
            } => {
                assert_eq!(state, "ready");
                assert_eq!(options, ["default", "off", "low", "high"]);
                assert_eq!(actual, selected);
            }
            _ => panic!("expected effort completion"),
        }
    }
    for rx in &receivers[2..] {
        assert!(rx.try_recv().is_err());
    }
    assert!(state.rest.catalogue_pending.is_none());
    assert!(state.rest.oa_detail_pending.is_empty());
}
