#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use crate::model::app_config::{ModelEntry, ModelRole, OAuthConn, OAuthProvider, ProviderConn};

fn state(provider: OAuthProvider, id: &str, ndjson: bool) -> AppState {
    let mut state = AppState::new(Mode::Chat);
    state.rest.config.oauth_conns.push(OAuthConn {
        uuid: "effort-oauth".into(),
        provider,
        access_token: "test".into(),
        commandcode_chat: ndjson.then(|| "ndjson".into()),
        ..Default::default()
    });
    let settings = crate::model::settings::Settings {
        model: "stale-legacy-id".into(),
        session_models: vec![ModelEntry {
            uuid: "effort-model".into(),
            model_id: id.into(),
            provider_uuid: "effort-oauth".into(),
            roles: vec![ModelRole::Main],
            ..Default::default()
        }],
        ..Default::default()
    };
    state.rest.fg_mut().session = Some(crate::model::session::Session::new(
        "test".into(),
        Default::default(),
        "test".into(),
        settings,
        crate::model::conversation::Conversation::new(""),
    ));
    state
}

#[test]
fn cold_cc_ndjson_requests_detail_once_never_native_catalogue() {
    let mut state = state(OAuthProvider::CommandCode, "effort-test-cold-ndjson", true);
    for _ in 0..3 {
        assert!(matches!(
            derive_effort_menu(&mut state),
            EffortMenu::Loading(_)
        ));
    }
    assert!(state.rest.catalogue_pending.is_none());
    assert_eq!(state.rest.oa_detail_pending.len(), 1);
    let (key, provider, id) = &state.rest.oa_detail_pending[0];
    assert_eq!(key, crate::service::oauth::registry::COMMANDCODE_API_BASE);
    assert_eq!(*provider, Some(OAuthProvider::CommandCode));
    assert_eq!(id, "effort-test-cold-ndjson");
}

#[test]
fn oauth_identity_is_uuid_not_endpoint_or_legacy_model() {
    let mut state = state(OAuthProvider::CommandCode, "effort-test-identity", true);
    let mut route = crate::app::resolve::resolve_role(
        &state.rest.config,
        &state.rest.fg().session.as_ref().unwrap().settings,
        ModelRole::Main,
    )
    .unwrap();
    assert_eq!(
        route.endpoint,
        crate::service::oauth::registry::COMMANDCODE_CHAT_BASE
    );
    let key = route_catalogue_key(&state.rest.config, &route);
    route.endpoint = crate::service::oauth::registry::COMMANDCODE_API_BASE.into();
    assert_eq!(route_catalogue_key(&state.rest.config, &route), key);
    state.rest.config.oauth_conns[0].provider = OAuthProvider::Kilocode;
    // Deliberately identical chat URL: identity still follows the UUID's provider.
    assert_eq!(
        route_provider(&state.rest.config, &route),
        Some(OAuthProvider::Kilocode)
    );
    assert_eq!(
        route_catalogue_key(&state.rest.config, &route),
        "https://api.kilo.ai/api/gateway"
    );
}

#[test]
fn terminal_detail_without_caps_or_failure_never_retries() {
    for success in [true, false] {
        let mut state = state(OAuthProvider::CommandCode, "effort-test-terminal", false);
        state.rest.oa_detail_completed.insert(
            (
                crate::service::oauth::registry::COMMANDCODE_API_BASE.into(),
                "effort-test-terminal".into(),
            ),
            success,
        );
        match derive_effort_menu(&mut state) {
            EffortMenu::Unsupported(note) => assert_eq!(
                note,
                if success {
                    "model has no thinking control"
                } else {
                    "model capabilities unavailable"
                }
            ),
            _ => panic!("must be terminal"),
        }
        assert!(state.rest.oa_detail_pending.is_empty());
        assert!(state.rest.catalogue_pending.is_none());
    }
}

#[test]
fn static_gateway_native_reasoning_is_preserved() {
    let mut state = state(OAuthProvider::CommandCode, "effort-native", false);
    state.rest.config.oauth_conns.clear();
    state.rest.config.providers.push(ProviderConn {
        uuid: "effort-oauth".into(),
        endpoint: "https://native.example/v1".into(),
        api_key: "test".into(),
        ..Default::default()
    });
    state.rest.models_cache_endpoint = Some("https://native.example/v1".into());
    state.rest.models_cache = Some(vec![serde_json::from_value(serde_json::json!({
        "id": "effort-native", "reasoning": { "supported_efforts": ["low", "high"] }
    }))
    .unwrap()]);
    assert!(matches!(
        derive_effort_menu(&mut state),
        EffortMenu::Ready { .. }
    ));
    assert!(state.rest.oa_detail_pending.is_empty());
    assert!(state.rest.catalogue_pending.is_none());
}

#[test]
fn cc_static_routes_never_fetch_root_or_base() {
    for endpoint in [
        crate::service::oauth::registry::COMMANDCODE_CHAT_BASE,
        crate::service::oauth::registry::COMMANDCODE_API_BASE,
    ] {
        assert!(native_effort_endpoint(endpoint).is_none());
    }
    assert_eq!(
        native_effort_endpoint("https://api.kilo.ai/api/openrouter").as_deref(),
        Some("https://api.kilo.ai/api/gateway")
    );
}

#[test]
fn reasoning_caps_ready_preserve_efforts_and_default_selection() {
    let state = state(OAuthProvider::CommandCode, "effort-ready", true);
    let caps = crate::service::openrouter::EffortCaps {
        supported: true,
        mandatory: false,
        efforts: vec!["high".into(), "xhigh".into()],
    };
    match ready_from_caps(&state, &caps) {
        EffortMenu::Ready {
            options, selected, ..
        } => {
            assert_eq!(options, ["default", "off", "high", "xhigh"]);
            assert_eq!(selected, 0);
        }
        _ => panic!("supported caps must be ready"),
    }
}

#[test]
fn oauth_gateways_never_fall_back_to_native_catalogues() {
    for provider in [
        OAuthProvider::Codex,
        OAuthProvider::ClaudeAI,
        OAuthProvider::Kilocode,
        OAuthProvider::KomaRun,
        OAuthProvider::Xai,
        OAuthProvider::CommandCode,
    ] {
        let mut state = state(provider, "effort-oa-only-unique", false);
        assert!(matches!(
            derive_effort_menu(&mut state),
            EffortMenu::Loading(_)
        ));
        assert!(state.rest.catalogue_pending.is_none());
        let (key, _, model) = state.rest.oa_detail_pending[0].clone();
        state.rest.oa_detail_completed.insert((key, model), false);
        assert!(matches!(
            derive_effort_menu(&mut state),
            EffortMenu::Unsupported(_)
        ));
        assert!(state.rest.catalogue_pending.is_none());
    }
}

#[test]
fn openrouter_host_not_gateway_path_owns_live_catalogue() {
    assert!(is_live_openrouter("https://openrouter.ai/api/v1"));
    assert!(!is_live_openrouter("https://api.kilo.ai/api/openrouter"));
    assert!(!is_live_openrouter("https://gateway.example/openrouter"));
}
