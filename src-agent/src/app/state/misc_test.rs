#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;

#[test]
fn explicit_catalogue_retry_clears_prior_failure() {
    let endpoint = "https://koma.run/api/v1/koma-premium";
    let mut rest = AppStateRest::new();
    rest.models_cache_failed = Some(endpoint.to_string());

    rest.request_catalogue(endpoint, "access-token", "koma-uuid");

    assert_eq!(rest.models_cache_failed, None);
    let pending = rest.catalogue_pending.expect("retry must be scheduled");
    assert_eq!(pending.endpoint, endpoint);
    assert_eq!(pending.oauth_uuid, "koma-uuid");
}

#[test]
fn detail_queue_dedupes_inflight_and_terminal_per_key_and_model() {
    let mut rest = AppStateRest::new();
    rest.request_oa_detail("a", None, "model");
    rest.request_oa_detail("a", None, "model");
    rest.request_oa_detail("b", None, "model");
    assert_eq!(rest.oa_detail_pending.len(), 2);
    rest.oa_detail_pending.clear();
    rest.oa_detail_inflight
        .remove(&("a".into(), "model".into()));
    rest.oa_detail_completed
        .insert(("a".into(), "model".into()), false);
    rest.request_oa_detail("a", None, "model");
    assert!(rest.oa_detail_pending.is_empty());
}
