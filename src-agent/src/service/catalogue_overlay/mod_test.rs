#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

#[test]
fn bundled_default_parses() {
    let table: OverlayTable =
        serde_json::from_str(BUNDLED_DEFAULT).expect("bundled models.json must parse");
    assert!(
        !table.is_empty(),
        "bundled table should have at least one endpoint"
    );
}

#[test]
fn lookup_unknown_returns_none() {
    let _ = OVERLAY.set(RwLock::new(OverlayState {
        table: load_initial(),
        ..OverlayState::default()
    }));
    assert!(lookup("https://not-a-real-endpoint", "nope").is_none());
}

#[test]
fn catalogue_key_separates_commandcode_transport() {
    use crate::service::oauth::registry::{COMMANDCODE_API_BASE, COMMANDCODE_CHAT_BASE};
    for chat in [COMMANDCODE_CHAT_BASE, COMMANDCODE_API_BASE] {
        assert_eq!(
            catalogue_key(chat, Some(OAuthProvider::CommandCode)),
            COMMANDCODE_API_BASE
        );
    }
    assert_eq!(
        catalogue_key("https://openrouter.ai/api/v1", None),
        "https://openrouter.ai/api/v1"
    );
    assert_eq!(
        catalogue_key("https://direct.example/v1", None),
        "https://direct.example/v1"
    );
    assert_eq!(
        catalogue_key(
            "https://api.kilo.ai/api/openrouter",
            Some(OAuthProvider::Kilocode)
        ),
        "https://api.kilo.ai/api/gateway"
    );
    assert_eq!(
        catalogue_key("https://api.anthropic.com", Some(OAuthProvider::ClaudeAI)),
        "https://api.anthropic.com"
    );
}

fn fixture(id: &str, efforts: &[&str]) -> OverlayModel {
    serde_json::from_value(serde_json::json!({
        "id": id,
        "reasoning": { "mandatory": false, "supported_efforts": efforts }
    }))
    .unwrap()
}

#[test]
fn detail_upserts_only_one_model() {
    let mut table = OverlayTable::new();
    table.insert(
        "cc".into(),
        vec![fixture("haiku", &[]), fixture("other", &["low"])],
    );
    upsert_model(&mut table, "cc", fixture("haiku", &["max", "high"]));
    assert_eq!(table["cc"].len(), 2);
    let info: Vec<_> = table["cc"]
        .iter()
        .map(OverlayModel::to_model_info)
        .collect();
    let caps = crate::service::openrouter::effort_caps(&info, "haiku");
    assert!(caps.supported);
    assert_eq!(caps.efforts, ["max", "high"]);
    upsert_model(&mut table, "cc", fixture("new", &["medium"]));
    assert_eq!(table["cc"].len(), 3);
}

#[test]
fn oa_and_details_survive_base_refresh_in_either_order() {
    let mut base = OverlayTable::new();
    base.insert("direct".into(), vec![fixture("deepseek", &["high"])]);
    base.insert("cc".into(), vec![fixture("haiku", &[])]);
    let mut oa = OverlayTable::new();
    oa.insert(
        "cc".into(),
        vec![fixture("haiku", &["low"]), fixture("other", &["high"])],
    );
    for oa_first in [true, false] {
        let mut state = OverlayState::default();
        if oa_first {
            state.merge_oa(oa.clone());
            state.replace_base(base.clone());
        } else {
            state.replace_base(base.clone());
            state.merge_oa(oa.clone());
        }
        upsert_model(
            &mut state.details,
            "cc",
            fixture("haiku", &["max", "xhigh"]),
        );
        state.apply_details();
        state.replace_base(base.clone());
        state.merge_oa(oa.clone());
        assert_eq!(state.table["direct"], base["direct"]);
        assert_eq!(state.table["cc"].len(), 2);
        assert_eq!(state.table["cc"][0], fixture("haiku", &["max", "xhigh"]));
    }
}
