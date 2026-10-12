#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::app::runtime::commands::effort::{derive_effort_menu, EffortMenu};
use crate::app::state::SessionRuntime;
use crate::model::app_config::{ModelEntry, ModelRole, OAuthConn, OAuthProvider};
use crate::service::catalogue_overlay::{merge_detail, OverlayModel};
use crate::service::oauth::registry::COMMANDCODE_API_BASE;

fn fixture(id: &str, caps: bool) -> OverlayModel {
    serde_json::from_value(if caps {
        serde_json::json!({
            "id": id, "reasoning": { "supported_efforts": ["low", "high", "xhigh"] }
        })
    } else {
        serde_json::json!({"id": id})
    })
    .unwrap()
}

fn session(id: &str, model: &str, effort: &str) -> SessionRuntime {
    let mut rt = SessionRuntime::new();
    let settings = crate::model::settings::Settings {
        effort: effort.into(),
        session_models: vec![ModelEntry {
            uuid: format!("{id}-model"),
            model_id: model.into(),
            provider_uuid: "cc-detail".into(),
            roles: vec![ModelRole::Main],
            ..Default::default()
        }],
        ..Default::default()
    };
    rt.id = id.into();
    rt.session = Some(crate::model::session::Session::new(
        id.into(),
        Default::default(),
        "test".into(),
        settings,
        crate::model::conversation::Conversation::new(""),
    ));
    rt.mode = Mode::Chat;
    rt
}

fn state(model: &str) -> AppState {
    let mut state = AppState::new(Mode::Chat);
    state.rest.config.oauth_conns.push(OAuthConn {
        uuid: "cc-detail".into(),
        provider: OAuthProvider::CommandCode,
        access_token: "test".into(),
        commandcode_chat: Some("ndjson".into()),
        ..Default::default()
    });
    state.rest.sessions = vec![
        session("matching-a", model, "high"),
        session("matching-b", model, "low"),
        session("unrelated", "effort-drain-unrelated", ""),
    ];
    state.rest.foreground = 2;
    state
}

#[test]
fn incomplete_detail_success_refreshes_all_matching_ndjson_sessions() {
    let model = "effort-drain-success-unique";
    merge_detail(COMMANDCODE_API_BASE, fixture(model, false));
    let mut state = state(model);
    state.rest.foreground = 0;
    assert!(matches!(
        derive_effort_menu(&mut state),
        EffortMenu::Loading(_)
    ));
    state.rest.sessions[0].status = "fetching model capabilities...".into();
    state.rest.sessions[1].status = "fetching model capabilities...".into();
    state.rest.sessions[1].mode = Mode::Effort(Box::new(crate::app::mode::EffortPickerState {
        options: vec!["default".into()],
        selected: 0,
        note: "loading".into(),
    }));
    state.rest.foreground = 2;
    // Replacing the catalogue/awareness channel cannot strand this result.
    let (_warm_tx, warm_rx) = tokio::sync::mpsc::unbounded_channel();
    state.rest.warm_rx = Some(warm_rx);
    state
        .rest
        .oa_detail_tx
        .send(WarmEvent::WarmOaDetail {
            catalogue_key: COMMANDCODE_API_BASE.into(),
            model_id: model.into(),
            result: Ok(fixture(model, true)),
        })
        .unwrap();
    assert!(drain_oa_details(&mut state));
    assert_eq!(state.rest.foreground, 2);
    assert!(
        matches!(state.rest.sessions[0].mode, Mode::Chat),
        "status-only loading must not steal focus"
    );
    assert!(state.rest.sessions[0].status.is_empty());
    {
        let (i, selected) = (1, 2);
        match &state.rest.sessions[i].mode {
            Mode::Effort(picker) => {
                assert_eq!(picker.options, ["default", "off", "low", "high", "xhigh"]);
                assert_eq!(picker.selected, selected);
            }
            _ => panic!("loading matching session must open ready picker"),
        }
        assert!(state.rest.sessions[i].status.is_empty());
    }
    assert!(matches!(state.rest.sessions[2].mode, Mode::Chat));
    assert_eq!(state.rest.effort_refresh_sessions.len(), 2);
    assert!(state.rest.oa_detail_inflight.is_empty());
    assert!(state.rest.catalogue_pending.is_none());
    // Ready NDJSON overlay needs neither native fetch nor detail re-request.
    state.rest.oa_detail_pending.clear();
    state.rest.foreground = 0;
    assert!(matches!(
        derive_effort_menu(&mut state),
        EffortMenu::Ready { .. }
    ));
    assert!(state.rest.oa_detail_pending.is_empty());
}

#[test]
fn detail_terminal_no_caps_and_failure_clear_loading_without_retry() {
    for (model, success) in [
        ("effort-drain-no-caps-unique", true),
        ("effort-drain-failed-unique", false),
    ] {
        let mut state = state(model);
        state.rest.sessions[0].status = "fetching model capabilities...".into();
        state.rest.request_oa_detail(
            COMMANDCODE_API_BASE,
            Some(OAuthProvider::CommandCode),
            model,
        );
        state.rest.oa_detail_pending.clear();
        state
            .rest
            .oa_detail_tx
            .send(WarmEvent::WarmOaDetail {
                catalogue_key: COMMANDCODE_API_BASE.into(),
                model_id: model.into(),
                result: if success {
                    Ok(fixture(model, false))
                } else {
                    Err("unavailable".into())
                },
            })
            .unwrap();
        assert!(drain_oa_details(&mut state));
        assert!(state.rest.oa_detail_inflight.is_empty());
        assert_eq!(
            state.rest.sessions[0].status,
            if success {
                "model has no thinking control"
            } else {
                "model capabilities unavailable"
            }
        );
        state.rest.foreground = 0;
        assert!(matches!(
            derive_effort_menu(&mut state),
            EffortMenu::Unsupported(_)
        ));
        assert!(state.rest.oa_detail_pending.is_empty());
    }
}

#[test]
fn warm_catalogue_success_refreshes_loading_openrouter_picker() {
    let mut state = AppState::new(Mode::Chat);
    let mut rt = session("native", "effort-native-or", "high");
    rt.session.as_mut().unwrap().settings.session_models.clear();
    rt.session.as_mut().unwrap().settings.model = "effort-native-or".into();
    rt.status = "fetching model capabilities...".into();
    state.rest.sessions = vec![rt];
    let endpoint = crate::config::DEFAULT_BASE_URL.to_string();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.rest.warm_rx = Some(rx);
    tx.send(WarmEvent::WarmCatalogue {
        endpoint,
        models: vec![fixture("effort-native-or", true).to_model_info()],
    })
    .unwrap();
    assert!(drain_warm(&mut state));
    assert!(matches!(state.mode(), Mode::Chat));
    assert!(state.rest.fg().status.is_empty());
    assert!(state.rest.effort_refresh_sessions.contains_key("native"));
}

#[test]
fn ready_overlay_is_immediate_before_any_fetch() {
    let model = "effort-drain-ready-unique";
    merge_detail(COMMANDCODE_API_BASE, fixture(model, true));
    let mut state = state(model);
    state.rest.foreground = 0;
    assert!(matches!(
        derive_effort_menu(&mut state),
        EffortMenu::Ready { .. }
    ));
    assert!(state.rest.oa_detail_pending.is_empty());
    assert!(state.rest.catalogue_pending.is_none());
}

#[test]
fn stale_detail_after_model_switch_does_not_touch_new_session() {
    let model = "effort-drain-stale-detail-unique";
    let mut state = state(model);
    for rt in &mut state.rest.sessions {
        rt.session.as_mut().unwrap().settings.session_models[0].model_id = "switched-model".into();
        rt.status = "keep this unrelated status".into();
    }
    apply_oa_detail(
        &mut state,
        COMMANDCODE_API_BASE.into(),
        model.into(),
        Ok(fixture(model, true)),
    );
    assert!(state.rest.effort_refresh_sessions.is_empty());
    assert!(state
        .rest
        .sessions
        .iter()
        .all(|rt| rt.status == "keep this unrelated status"));
}

#[test]
fn openrouter_failure_does_not_auto_retry_or_push() {
    let mut state = AppState::new(Mode::Chat);
    let mut rt = session("native", "effort-native-or", "high");
    rt.session.as_mut().unwrap().settings.session_models.clear();
    rt.status = "fetching model capabilities...".into();
    state.rest.sessions = vec![rt];
    let endpoint = crate::config::DEFAULT_BASE_URL.to_string();
    state.rest.catalogue_fetching = Some(endpoint.clone());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.rest.warm_rx = Some(rx);
    tx.send(WarmEvent::WarmCatalogueFailed {
        endpoint: endpoint.clone(),
        error: "test failure".into(),
    })
    .unwrap();
    assert!(drain_warm(&mut state));
    assert!(state.rest.catalogue_pending.is_none());
    assert!(state.rest.catalogue_fetching.is_none());
    assert_eq!(
        state.rest.models_cache_failed.as_deref(),
        Some(endpoint.as_str())
    );
    assert!(state.rest.effort_refresh_sessions.is_empty());
}

#[test]
fn stale_native_catalogue_success_does_not_refresh_another_endpoint() {
    let mut state = state("effort-stale-native-unique");
    state.rest.sessions[0].status = "keep this unrelated status".into();
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    state.rest.warm_rx = Some(rx);
    tx.send(WarmEvent::WarmCatalogue {
        endpoint: "https://other.example/v1".into(),
        models: vec![fixture("effort-stale-native-unique", true).to_model_info()],
    })
    .unwrap();
    assert!(drain_warm(&mut state));
    assert_eq!(state.rest.sessions[0].status, "keep this unrelated status");
    assert!(state.rest.effort_refresh_sessions.is_empty());
}
