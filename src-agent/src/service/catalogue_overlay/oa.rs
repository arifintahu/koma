//! Fetch OAuth provider catalogues from koma-landing `/api/v1/oa/providers/{id}`
//! and merge them into the catalogue overlay table (keyed by catalogue identity).
//! Also resolves on-demand public model detail for incomplete/missing rows.

use std::time::Duration;

use serde::Deserialize;

use crate::dto::openrouter::ModelReasoning;
use crate::model::app_config::OAuthProvider;
use crate::service::oauth::registry::{self, KOMA_PREMIUM_CHAT_ENDPOINT};

use super::model::{OverlayModel, OverlayPricing, OverlayTable};

/// Public OA catalogue base. Override with `KOMA_OA_BASE` for local landing.
const DEFAULT_OA_BASE: &str = "https://koma.run/api/v1/oa";
const OA_TTL: Duration = Duration::from_secs(3600);
const FETCH_TIMEOUT: Duration = Duration::from_secs(12);

/// Wire ids fetched on refresh (matches landing registry + `OAuthProvider::wire_id`).
const OA_PROVIDERS: &[(OAuthProvider, &str)] = &[
    (OAuthProvider::Codex, "codex"),
    (OAuthProvider::Xai, "xai"),
    (OAuthProvider::ClaudeAI, "claudeai"),
    (OAuthProvider::CommandCode, "commandcode"),
    (OAuthProvider::Kilocode, "kilocode"),
    (OAuthProvider::KomaRun, "komarun"),
];

#[derive(Debug, Deserialize)]
struct OaListResponse {
    #[serde(default)]
    data: Vec<OaRow>,
}

#[derive(Debug, Deserialize)]
struct OaRow {
    id: String,
    #[serde(default)]
    supported_parameters: Vec<String>,
    #[serde(default)]
    reasoning: Option<ModelReasoning>,
    #[serde(default)]
    context_length: Option<u64>,
    #[serde(default)]
    pricing: Option<OaPricing>,
    /// free | premium | exclusive — KomaRun endpoint split.
    #[serde(default)]
    tier: Option<String>,
}

#[derive(Debug, Deserialize)]
struct OaPricing {
    #[serde(default)]
    input: f64,
    #[serde(default)]
    cached: f64,
    #[serde(default)]
    output: f64,
}

impl From<OaRow> for OverlayModel {
    fn from(r: OaRow) -> Self {
        OverlayModel {
            id: r.id,
            supported_parameters: r.supported_parameters,
            reasoning: r.reasoning,
            context_length: r.context_length,
            pricing: r.pricing.map(|p| OverlayPricing {
                input: p.input,
                cached: p.cached,
                output: p.output,
            }),
        }
    }
}

fn oa_base() -> String {
    std::env::var("KOMA_OA_BASE").unwrap_or_else(|_| DEFAULT_OA_BASE.to_string())
}

/// Fetch public OA detail once, with provider membership preferred over the
/// bare OpenRouter join. The whole chain shares the catalogue's 12s budget;
/// no chat credentials are sent to the public OA service.
pub async fn fetch_oa_detail(
    provider: Option<OAuthProvider>,
    model_id: &str,
) -> anyhow::Result<OverlayModel> {
    let base = oa_base();
    fetch_detail_at(&base, provider, model_id).await
}

async fn fetch_detail_at(
    base: &str,
    provider: Option<OAuthProvider>,
    model_id: &str,
) -> anyhow::Result<OverlayModel> {
    let client = reqwest::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("koma/", env!("CARGO_PKG_VERSION")))
        .build()?;
    tokio::time::timeout(FETCH_TIMEOUT, async {
        if let Some(provider) = provider.filter(|p| *p != OAuthProvider::Extension) {
            let url = detail_url(base, Some(provider.wire_id()), model_id)?;
            if let Some(model) = fetch_detail_row(&client, url, model_id).await? {
                return Ok(model);
            }
        }
        let url = detail_url(base, None, model_id)?;
        fetch_detail_row(&client, url, model_id)
            .await?
            .ok_or_else(|| anyhow::anyhow!("model detail not found"))
    })
    .await
    .map_err(|_| anyhow::anyhow!("model detail timed out"))?
}

fn detail_url(base: &str, provider: Option<&str>, model_id: &str) -> anyhow::Result<url::Url> {
    anyhow::ensure!(
        !model_id.is_empty()
            && model_id
                .split('/')
                .all(|s| !s.is_empty() && s != "." && s != ".."),
        "invalid model detail id"
    );
    let mut url = url::Url::parse(base)?;
    url.set_query(None);
    url.set_fragment(None);
    {
        let mut path = url
            .path_segments_mut()
            .map_err(|_| anyhow::anyhow!("invalid OA base URL"))?;
        path.pop_if_empty().push("models");
        if let Some(provider) = provider {
            path.push(provider);
        }
        path.extend(model_id.split('/')).push("detail");
    }
    Ok(url)
}

async fn fetch_detail_row(
    client: &reqwest::Client,
    url: url::Url,
    model_id: &str,
) -> anyhow::Result<Option<OverlayModel>> {
    let resp = client.get(url).send().await?;
    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Ok(None);
    }
    anyhow::ensure!(
        resp.status() == reqwest::StatusCode::OK,
        "model detail status {}",
        resp.status()
    );
    let value: serde_json::Value = resp.json().await?;
    parse_detail(value, model_id)
}

fn parse_detail(value: serde_json::Value, model_id: &str) -> anyhow::Result<Option<OverlayModel>> {
    if value.get("matched").and_then(|v| v.as_bool()) == Some(false) {
        return Ok(None);
    }
    let row: OaRow = serde_json::from_value(value)?;
    anyhow::ensure!(!row.id.is_empty(), "model detail has empty id");
    let mut model = OverlayModel::from(row);
    // Bare OR resolution may return a canonical wire id rather than the full
    // requested id. Cache the capabilities under the caller's exact model id.
    model.id = model_id.to_string();
    Ok(Some(model))
}

/// Background thread: refresh OA catalogues and merge into the live overlay.
pub(super) fn spawn_refresh() {
    std::thread::spawn(|| {
        if let Err(e) = refresh_all() {
            crate::model::store::append_global_error_log(
                "catalogue oa",
                &format!("refresh failed: {e}"),
            );
        }
    });
}

fn refresh_all() -> anyhow::Result<()> {
    let base_dir = crate::model::store::base_dir()?;
    let oa_dir = base_dir.join("oa");
    let _ = std::fs::create_dir_all(&oa_dir);

    // TTL gate: skip network if every provider disk cache is fresh.
    if OA_PROVIDERS
        .iter()
        .all(|(_, id)| is_fresh(&oa_dir.join(format!("{id}.json"))))
    {
        // Still merge disk into memory (covers cold start after init from models.json).
        merge_disk_into_overlay(&oa_dir);
        return Ok(());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(FETCH_TIMEOUT)
        .user_agent(concat!("koma/", env!("CARGO_PKG_VERSION")))
        .build()?;

    let base = oa_base();
    let mut patch = OverlayTable::new();

    for (provider, wire_id) in OA_PROVIDERS {
        let url = format!("{base}/providers/{wire_id}");
        let cache_path = oa_dir.join(format!("{wire_id}.json"));

        let body = match client.get(&url).send() {
            Ok(resp) if resp.status().is_success() => match resp.text() {
                Ok(t) => t,
                Err(e) => {
                    crate::model::store::append_global_error_log(
                        "catalogue oa",
                        &format!("{wire_id}: body {e}"),
                    );
                    // fall through to disk
                    String::new()
                }
            },
            Ok(resp) => {
                crate::model::store::append_global_error_log(
                    "catalogue oa",
                    &format!("{wire_id}: status {}", resp.status()),
                );
                String::new()
            }
            Err(e) => {
                crate::model::store::append_global_error_log(
                    "catalogue oa",
                    &format!("{wire_id}: {e}"),
                );
                String::new()
            }
        };

        let text = if body.is_empty() {
            std::fs::read_to_string(&cache_path).unwrap_or_default()
        } else {
            let _ = atomic_write(&cache_path, body.as_bytes());
            body
        };

        if text.is_empty() {
            continue;
        }

        let parsed: OaListResponse = match serde_json::from_str(&text) {
            Ok(p) => p,
            Err(e) => {
                crate::model::store::append_global_error_log(
                    "catalogue oa",
                    &format!("{wire_id}: parse {e}"),
                );
                continue;
            }
        };

        apply_provider_rows(*provider, parsed.data, &mut patch);
    }

    if !patch.is_empty() {
        super::merge_overlay_patch(patch);
        crate::model::store::append_global_error_log(
            "catalogue oa",
            &format!("merged OA catalogues from {base}"),
        );
    }
    Ok(())
}

pub(super) fn merge_disk_into_overlay(oa_dir: &std::path::Path) {
    let mut patch = OverlayTable::new();
    for (provider, wire_id) in OA_PROVIDERS {
        let path = oa_dir.join(format!("{wire_id}.json"));
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(parsed) = serde_json::from_str::<OaListResponse>(&text) else {
            continue;
        };
        apply_provider_rows(*provider, parsed.data, &mut patch);
    }
    if !patch.is_empty() {
        super::merge_overlay_patch(patch);
    }
}

fn apply_provider_rows(provider: OAuthProvider, rows: Vec<OaRow>, patch: &mut OverlayTable) {
    if provider == OAuthProvider::KomaRun {
        let mut base_rows = Vec::new();
        let mut premium_rows = Vec::new();
        for r in rows {
            let tier = r.tier.clone().unwrap_or_default();
            let model = OverlayModel::from(r);
            match tier.as_str() {
                "free" => base_rows.push(model),
                "premium" | "exclusive" => premium_rows.push(model),
                _ => {
                    // Untagged: peach / koma/* → premium; else base.
                    if model.id.starts_with("koma/") {
                        premium_rows.push(model);
                    } else {
                        // Gateway allowlist ids live on premium chat path for KomaRun.
                        premium_rows.push(model);
                    }
                }
            }
        }
        // Free apple on base endpoint; everything else (peach + gateway) on premium.
        let base_ep = registry::meta(OAuthProvider::KomaRun).chat_endpoint;
        // Empty lists are authoritative too: a refresh may remove a whole tier.
        patch.insert(base_ep.to_string(), base_rows);
        patch.insert(KOMA_PREMIUM_CHAT_ENDPOINT.to_string(), premium_rows);
        return;
    }

    let endpoint = super::catalogue_key(registry::meta(provider).chat_endpoint, Some(provider));
    if endpoint.is_empty() {
        return;
    }
    let models: Vec<OverlayModel> = rows.into_iter().map(OverlayModel::from).collect();
    patch.insert(endpoint, models);
}

fn is_fresh(path: &std::path::Path) -> bool {
    let modified = match std::fs::metadata(path).and_then(|m| m.modified()) {
        Ok(m) => m,
        Err(_) => return false,
    };
    match modified.elapsed() {
        Ok(age) => age < OA_TTL,
        Err(_) => false,
    }
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or(std::path::Path::new("."));
    let file_name = path
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "no file name"))?;
    let tmp = parent.join(format!(
        ".{}.tmp.{}",
        file_name.to_string_lossy(),
        std::process::id()
    ));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]
    use super::*;

    #[test]
    fn empty_public_catalogue_replaces_both_koma_tiers() {
        let mut patch = OverlayTable::new();
        apply_provider_rows(OAuthProvider::KomaRun, Vec::new(), &mut patch);
        assert!(patch[registry::meta(OAuthProvider::KomaRun).chat_endpoint].is_empty());
        assert!(patch[KOMA_PREMIUM_CHAT_ENDPOINT].is_empty());
        apply_provider_rows(OAuthProvider::Xai, Vec::new(), &mut patch);
        assert!(patch[registry::meta(OAuthProvider::Xai).chat_endpoint].is_empty());
    }

    #[test]
    fn detail_url_preserves_model_segments_and_encodes_reserved_chars() {
        let url = detail_url(
            "https://example.test/api/v1/oa/",
            Some("commandcode"),
            "author/model?#",
        )
        .unwrap();
        assert_eq!(
            url.as_str(),
            "https://example.test/api/v1/oa/models/commandcode/author/model%3F%23/detail"
        );
        assert!(detail_url("https://example.test/oa", None, "../model").is_err());
        assert!(detail_url("https://example.test/oa", None, "").is_err());
    }

    #[test]
    fn detail_parsing_requires_a_match_and_a_nonempty_id() {
        use serde_json::json;
        assert!(parse_detail(json!({"matched": false}), "haiku")
            .unwrap()
            .is_none());
        assert!(parse_detail(json!({"id": ""}), "haiku").is_err());
        assert!(parse_detail(json!({"reasoning": {}}), "haiku").is_err());
        let model = parse_detail(json!({
            "id": "claude-haiku-5-5",
            "reasoning": {"mandatory": false, "supported_efforts": ["max", "xhigh", "high", "medium", "low"]},
            "context_length": 200000,
            "pricing": {"input": 1.0, "cached": 0.1, "output": 5.0}
        }), "anthropic/claude-haiku-5.5").unwrap().unwrap();
        assert_eq!(model.id, "anthropic/claude-haiku-5.5");
        assert_eq!(model.context_length, Some(200000));
        assert_eq!(model.pricing.as_ref().unwrap().input, 1.0);
        let caps = crate::service::openrouter::effort_caps(&[model.to_model_info()], &model.id);
        assert!(caps.supported);
        assert_eq!(caps.efforts, ["max", "xhigh", "high", "medium", "low"]);
        assert!(
            parse_detail(json!({"id": "haiku", "matched": true}), "haiku")
                .unwrap()
                .is_some()
        );
    }

    fn mock_detail_server(
        responses: Vec<(u16, &'static str)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}/api/v1/oa", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let thread = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let deadline = std::time::Instant::now() + Duration::from_secs(4);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(
                                std::time::Instant::now() < deadline,
                                "detail request not received"
                            );
                            std::thread::sleep(Duration::from_millis(10));
                        }
                        Err(e) => panic!("accept: {e}"),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                let mut byte = [0u8; 1];
                while !request.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                requests.push(String::from_utf8(request).unwrap());
                write!(stream, "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (base, thread)
    }

    #[tokio::test]
    async fn detail_404_falls_through_to_bare_without_credentials() {
        let (base, server) = mock_detail_server(vec![
            (404, r#"{"matched":false}"#),
            (
                200,
                r#"{"id":"claude-haiku-5-5","matched":true,"reasoning":{"supported_efforts":["high","low"]}}"#,
            ),
        ]);
        let result =
            fetch_detail_at(&base, Some(OAuthProvider::CommandCode), "claude-haiku-5-5").await;
        let requests = server.join().unwrap();
        let model = result.unwrap();
        assert!(model.reasoning.is_some());
        assert!(
            requests[0].starts_with("GET /api/v1/oa/models/commandcode/claude-haiku-5-5/detail ")
        );
        assert!(requests[1].starts_with("GET /api/v1/oa/models/claude-haiku-5-5/detail "));
        for request in requests {
            assert!(!request.to_lowercase().contains("authorization:"));
            assert!(request.to_lowercase().contains("user-agent: koma/"));
        }
    }

    #[tokio::test]
    async fn detail_unknown_and_http_failure_are_terminal() {
        let (base, server) = mock_detail_server(vec![(404, "{}"), (404, "{}")]);
        assert!(
            fetch_detail_at(&base, Some(OAuthProvider::CommandCode), "unknown")
                .await
                .is_err()
        );
        assert_eq!(server.join().unwrap().len(), 2);
        let (base, server) = mock_detail_server(vec![(503, "{}")]);
        assert!(
            fetch_detail_at(&base, Some(OAuthProvider::CommandCode), "unknown")
                .await
                .is_err()
        );
        assert_eq!(server.join().unwrap().len(), 1);
    }

    #[test]
    fn provider_rows_use_catalogue_identity() {
        for provider in [OAuthProvider::CommandCode, OAuthProvider::Kilocode] {
            let parsed: OaListResponse =
                serde_json::from_str(r#"{"data":[{"id":"model"}]}"#).unwrap();
            let mut patch = OverlayTable::new();
            apply_provider_rows(provider, parsed.data, &mut patch);
            let key =
                super::super::catalogue_key(registry::meta(provider).chat_endpoint, Some(provider));
            assert_eq!(patch[&key][0].id, "model");
        }
    }

    #[test]
    fn maps_oa_row_to_overlay() {
        let raw = r#"{
          "data": [{
            "id": "grok-4.7",
            "supported_parameters": ["reasoning"],
            "reasoning": { "mandatory": false, "supported_efforts": ["low","high"] },
            "context_length": 256000,
            "pricing": { "input": 1.0, "cached": 0.1, "output": 2.0 }
          }]
        }"#;
        let parsed: OaListResponse = serde_json::from_str(raw).unwrap();
        let mut patch = OverlayTable::new();
        apply_provider_rows(OAuthProvider::Xai, parsed.data, &mut patch);
        let ep = registry::meta(OAuthProvider::Xai).chat_endpoint;
        let m = &patch.get(ep).unwrap()[0];
        assert_eq!(m.id, "grok-4.7");
        assert!(m.reasoning.is_some());
        assert_eq!(m.pricing.as_ref().unwrap().input, 1.0);
    }

    #[test]
    fn komarun_splits_tiers() {
        let raw = r#"{
          "data": [
            { "id": "koma/apple", "tier": "free" },
            { "id": "koma/peach", "tier": "exclusive" },
            { "id": "openai/gpt-5", "tier": "premium" }
          ]
        }"#;
        let parsed: OaListResponse = serde_json::from_str(raw).unwrap();
        let mut patch = OverlayTable::new();
        apply_provider_rows(OAuthProvider::KomaRun, parsed.data, &mut patch);
        let base = registry::meta(OAuthProvider::KomaRun).chat_endpoint;
        assert_eq!(patch.get(base).unwrap()[0].id, "koma/apple");
        let prem = patch.get(KOMA_PREMIUM_CHAT_ENDPOINT).unwrap();
        assert!(prem.iter().any(|m| m.id == "koma/peach"));
        assert!(prem.iter().any(|m| m.id == "openai/gpt-5"));
    }
}
