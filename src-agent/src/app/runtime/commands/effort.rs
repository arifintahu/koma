//! Effort picker command: `/effort`

use std::sync::Arc;

use anyhow::Result;

use crate::app::mode::{EffortPickerState, Mode};
use crate::app::state::AppState;
use crate::service::openrouter::OpenRouterClient;

/// Append `opt` to `out` unless it's already present (case-sensitive). Keeps the
/// option list deduped while preserving the order options are added in.
pub(super) fn push_unique(out: &mut Vec<String>, opt: &str) {
    if !out.iter().any(|o| o == opt) {
        out.push(opt.to_string());
    }
}

/// Build the `/effort` option list from a model's derived [`EffortCaps`].
///
/// Returns `None` when the model has no reasoning control at all (the caller
/// toasts and does NOT open the menu). Otherwise:
/// - discrete efforts reported → `["default","off"] + efforts` (deduped, model
///   order preserved); `"off"` dropped when reasoning is mandatory.
/// - supported but no discrete efforts (on/off only) → `["default","off","max"]`
///   (`"max"` == thinking on); `"off"` dropped when mandatory.
///
/// `"default"` is always first so the model-default choice is one keypress away.
pub(super) fn build_effort_options(
    caps: &crate::service::openrouter::EffortCaps,
) -> Option<Vec<String>> {
    if !caps.supported {
        return None;
    }
    let mut out: Vec<String> = Vec::new();
    push_unique(&mut out, "default");
    if !caps.mandatory {
        push_unique(&mut out, "off");
    }
    if caps.efforts.is_empty() {
        // On/off-only model: "max" stands in for "thinking on".
        push_unique(&mut out, "max");
    } else {
        for e in &caps.efforts {
            push_unique(&mut out, e);
        }
    }
    Some(out)
}

/// Index of the option matching the session's stored `effort` (empty → the
/// `"default"` entry). Falls back to 0 when the stored value isn't offered.
pub(super) fn preselect_effort(options: &[String], effort: &str) -> usize {
    let want = if effort.is_empty() { "default" } else { effort };
    options.iter().position(|o| o == want).unwrap_or(0)
}

/// Outcome of deriving the `/effort` menu for the current model, shared by the
/// TUI `/effort` command and the GUI's `GetEffortOptions` daemon request — both
/// need the IDENTICAL per-model derivation (incl. the cold-cache fetch-arm side
/// effect below), just with different presentations of the result:
/// - TUI: `Loading`/`Unsupported` become a status-line message; `Ready` opens
///   `Mode::Effort`.
/// - GUI: all three become a `DaemonEvent::EffortOptions` reply (`state`
///   `"loading"`/`"unsupported"`/`"ready"`) so the picker never hangs.
pub(crate) enum EffortMenu {
    /// No usable (cached, Main-endpoint-matching) catalogue yet — a fetch has
    /// just been armed (or was already in flight). `String` is the status
    /// message to show while waiting (mirrors the TUI's prior inline text).
    Loading(String),
    /// The model has no reasoning control at all (or there's no active
    /// session/client to derive one from). `String` explains why; the caller
    /// shows it and does NOT open a menu.
    Unsupported(String),
    /// A menu is ready to show.
    Ready {
        options: Vec<String>,
        selected: usize,
        note: String,
    },
}

/// Build a [`EffortMenu::Ready`]/[`EffortMenu::Unsupported`] outcome from
/// already-derived [`EffortCaps`], shared by BOTH capability sources: the live
/// `models_cache` catalogue (OpenRouter) and the curated `catalogue_overlay`
/// (non-OpenRouter). Keeps the option-list/note/preselect logic in one place
/// so the two callers can't drift.
fn ready_from_caps(state: &AppState, caps: &crate::service::openrouter::EffortCaps) -> EffortMenu {
    match build_effort_options(caps) {
        Some(options) => {
            let note = if caps.efforts.is_empty() {
                "thinking on/off only".to_string()
            } else if caps.mandatory {
                "reasoning is always on for this model".to_string()
            } else {
                "pick a thinking effort".to_string()
            };
            let stored = state
                .rest
                .fg()
                .session
                .as_ref()
                .map(|s| s.settings.effort.clone())
                .unwrap_or_default();
            let selected = preselect_effort(&options, &stored);
            EffortMenu::Ready {
                options,
                selected,
                note,
            }
        }
        None => {
            // No reasoning control: don't open the menu, just say so.
            EffortMenu::Unsupported("model has no thinking control".to_string())
        }
    }
}

/// OAuth identity must come from the resolved UUID, never the chat URL (CC
/// switches between API and NDJSON; KomaRun switches between tier endpoints).
pub(crate) fn route_provider(
    config: &crate::model::app_config::AppConfig,
    route: &crate::app::resolve::Resolved,
) -> Option<crate::model::app_config::OAuthProvider> {
    config
        .oauth_conns
        .iter()
        .find(|c| !route.oauth_uuid.is_empty() && c.uuid == route.oauth_uuid)
        .map(|c| c.provider)
}

pub(crate) fn route_catalogue_key(
    config: &crate::model::app_config::AppConfig,
    route: &crate::app::resolve::Resolved,
) -> String {
    crate::service::catalogue_overlay::catalogue_key(&route.endpoint, route_provider(config, route))
}

/// Only the actual OpenRouter host owns the authoritative live effort path.
/// Gateway paths containing `/openrouter` (Kilo) are NOT OpenRouter identity.
pub(crate) fn is_live_openrouter(endpoint: &str) -> bool {
    url::Url::parse(endpoint).ok().is_some_and(|url| {
        url.host_str()
            .is_some_and(|host| host == "openrouter.ai" || host.ends_with(".openrouter.ai"))
    })
}

/// Native catalogue location for static-key gateways. CC must NEVER probe
/// /models at either its API base or its NDJSON root for effort metadata.
pub(crate) fn native_effort_endpoint(endpoint: &str) -> Option<String> {
    use crate::model::app_config::OAuthProvider;
    use crate::service::oauth::registry;
    let host = url::Url::parse(endpoint)
        .ok()
        .and_then(|u| u.host_str().map(str::to_owned));
    if host.as_deref() == Some("api.commandcode.ai") {
        return None;
    }
    for provider in [
        OAuthProvider::Codex,
        OAuthProvider::ClaudeAI,
        OAuthProvider::Kilocode,
        OAuthProvider::KomaRun,
        OAuthProvider::Xai,
    ] {
        let meta = registry::meta(provider);
        if endpoint.trim_end_matches('/') == meta.chat_endpoint.trim_end_matches('/') {
            return (!meta.catalogue_endpoint.is_empty())
                .then(|| meta.catalogue_endpoint.to_string());
        }
    }
    Some(endpoint.to_string())
}

/// Shared derivation for TUI, GUI requests, and completion refreshes.
pub(crate) fn effort_menu(
    state: &mut AppState,
    client: &mut Option<Arc<OpenRouterClient>>,
) -> EffortMenu {
    if client.is_none() {
        return EffortMenu::Unsupported("no active session".into());
    }
    derive_effort_menu(state)
}

pub(crate) fn derive_effort_menu(state: &mut AppState) -> EffortMenu {
    let Some(settings) = state.rest.fg().session.as_ref().map(|s| s.settings.clone()) else {
        return EffortMenu::Unsupported("no active session".into());
    };
    let main = crate::app::resolve::resolve_role(
        &state.rest.config,
        &settings,
        crate::model::app_config::ModelRole::Main,
    );
    let Some(route) = main else {
        return EffortMenu::Unsupported("model capabilities unavailable".into());
    };
    let is_or = is_live_openrouter(&route.endpoint);
    if !is_or {
        use crate::service::catalogue_overlay;
        let provider = route_provider(&state.rest.config, &route);
        let key = route_catalogue_key(&state.rest.config, &route);
        let mut overlay = catalogue_overlay::models_for(&key);
        if let Some(p) =
            provider.filter(|p| *p != crate::model::app_config::OAuthProvider::Extension)
        {
            // Include runtime key AND provider aliases/tiers. Do not let an
            // incomplete canonical duplicate hide reasoning in a legacy alias.
            for model in catalogue_overlay::models_for_provider(p) {
                if !overlay.iter().any(|m| m.id == model.id) {
                    overlay.push(model);
                } else if crate::service::openrouter::effort_caps(
                    std::slice::from_ref(&model),
                    &model.id,
                )
                .supported
                {
                    if let Some(existing) = overlay.iter_mut().find(|m| m.id == model.id) {
                        if !crate::service::openrouter::effort_caps(
                            std::slice::from_ref(existing),
                            &existing.id,
                        )
                        .supported
                        {
                            *existing = model;
                        }
                    }
                }
            }
        }
        let caps = crate::service::openrouter::effort_caps(&overlay, &route.model_id);
        if caps.supported {
            return ready_from_caps(state, &caps);
        }
        let completed = state
            .rest
            .oa_detail_completed
            .contains_key(&(key.clone(), route.model_id.clone()));
        // OA is preferred for OAuth gateways; a single terminal detail attempt
        // may fall back to genuine native reasoning. Static gateways can use
        // their native catalogue first. CC has no native effort probe, ever.
        let native = match provider {
            Some(crate::model::app_config::OAuthProvider::CommandCode) => None,
            Some(crate::model::app_config::OAuthProvider::Extension) | None => {
                native_effort_endpoint(&route.endpoint)
            }
            Some(p) => {
                let endpoint = crate::service::oauth::registry::meta(p).catalogue_endpoint;
                (!endpoint.is_empty()).then(|| endpoint.to_string())
            }
        };
        if provider.is_none() || completed {
            if let Some(endpoint) = native {
                let cached = state.rest.models_cache_endpoint.as_deref() == Some(endpoint.as_str())
                    && state.rest.models_cache.is_some();
                if cached {
                    if let Some(models) = &state.rest.models_cache {
                        let caps = crate::service::openrouter::effort_caps(models, &route.model_id);
                        if caps.supported {
                            return ready_from_caps(state, &caps);
                        }
                    }
                } else if state
                    .rest
                    .catalogue_pending
                    .as_ref()
                    .is_some_and(|p| p.endpoint == endpoint)
                    || state.rest.catalogue_fetching.as_deref() == Some(endpoint.as_str())
                {
                    return EffortMenu::Loading("fetching model capabilities...".into());
                } else if state.rest.models_cache_failed.as_deref() != Some(endpoint.as_str())
                    && state.rest.effort_native_attempted.insert(endpoint.clone())
                {
                    arm_catalogue(state, &endpoint, &route);
                    return EffortMenu::Loading("fetching model capabilities...".into());
                }
            }
        }
        match state
            .rest
            .oa_detail_completed
            .get(&(key.clone(), route.model_id.clone()))
        {
            Some(true) => EffortMenu::Unsupported("model has no thinking control".into()),
            Some(false) => EffortMenu::Unsupported("model capabilities unavailable".into()),
            None => {
                state
                    .rest
                    .request_oa_detail(&key, provider, &route.model_id);
                EffortMenu::Loading("fetching model capabilities...".into())
            }
        }
    } else {
        // OpenRouter remains authoritative and explicitly re-opened failures retry.
        let prev_fetch_failed =
            state.rest.models_cache_failed.as_deref() == Some(route.endpoint.as_str());
        if prev_fetch_failed {
            state.rest.models_cache_failed = None;
        }
        arm_catalogue(state, &route.endpoint, &route);
        if let Some(models) = state.rest.models_cache.as_ref().filter(|_| {
            state.rest.models_cache_endpoint.as_deref() == Some(route.endpoint.as_str())
        }) {
            ready_from_caps(
                state,
                &crate::service::openrouter::effort_caps(models, &route.model_id),
            )
        } else {
            EffortMenu::Loading(
                if prev_fetch_failed {
                    "couldn't fetch capabilities — retrying..."
                } else {
                    "fetching model capabilities..."
                }
                .into(),
            )
        }
    }
}

fn arm_catalogue(state: &mut AppState, endpoint: &str, route: &crate::app::resolve::Resolved) {
    let pending = state
        .rest
        .catalogue_pending
        .as_ref()
        .is_some_and(|p| p.endpoint == endpoint);
    let fetching = state.rest.catalogue_fetching.as_deref() == Some(endpoint);
    if !pending && !fetching {
        state
            .rest
            .request_catalogue(endpoint, &route.api_key, &route.oauth_uuid);
    }
}

/// Fold completion into every matching session, not the stale global cursor.
/// Re-derive only a loading status or an open picker; never steal another modal.
pub(crate) fn refresh_effort_sessions(
    state: &mut AppState,
    mut matches: impl FnMut(
        &crate::model::app_config::AppConfig,
        &crate::app::resolve::Resolved,
    ) -> bool,
) {
    let saved_fg = state.rest.foreground;
    for i in 0..state.rest.sessions.len() {
        let rt = &state.rest.sessions[i];
        if rt.closed {
            continue;
        }
        let route = rt.session.as_ref().and_then(|s| {
            crate::app::resolve::resolve_role(
                &state.rest.config,
                &s.settings,
                crate::model::app_config::ModelRole::Main,
            )
        });
        if !route
            .as_ref()
            .is_some_and(|r| matches(&state.rest.config, r))
        {
            continue;
        }
        let identity = route.as_ref().map(|r| {
            (
                route_catalogue_key(&state.rest.config, r),
                r.model_id.clone(),
            )
        });
        if let Some(identity) = identity {
            state
                .rest
                .effort_refresh_sessions
                .insert(rt.id.clone(), identity);
        }
        let loading = rt.status == "fetching model capabilities..."
            || rt.status == "couldn't fetch capabilities — retrying...";
        let picker = matches!(rt.mode, Mode::Effort(_));
        if !loading && !picker {
            continue;
        }
        state.rest.foreground = i;
        match derive_effort_menu(state) {
            EffortMenu::Ready {
                options,
                selected,
                note,
            } => {
                if picker {
                    *state.mode_mut() = Mode::Effort(Box::new(EffortPickerState {
                        options,
                        selected,
                        note,
                    }));
                }
                if loading {
                    state.rest.fg_mut().status.clear();
                }
            }
            EffortMenu::Unsupported(note) => {
                if picker {
                    *state.mode_mut() = Mode::Chat;
                }
                state.rest.fg_mut().status = note;
            }
            EffortMenu::Loading(note) => state.rest.fg_mut().status = note,
        }
    }
    state.rest.foreground = saved_fg;
}

/// Handle the `/effort` command: open the effort picker for the current model.
///
/// Opening a picker overlay is always safe mid-stream (read-only view; the
/// turn keeps streaming), so there is no busy guard here. The effort value is
/// only written when the user CONFIRMS a selection inside the picker, which is
/// a separate handler. Unchanged behavior from before the `effort_menu`
/// extraction: `Loading`/`Unsupported` set the SAME status-line text the
/// inline logic used to, and `Ready` opens the SAME `Mode::Effort`.
pub(super) fn handle_effort(
    state: &mut AppState,
    client: &mut Option<Arc<OpenRouterClient>>,
) -> Result<()> {
    match effort_menu(state, client) {
        EffortMenu::Loading(msg) | EffortMenu::Unsupported(msg) => {
            state.rest.fg_mut().status = msg;
        }
        EffortMenu::Ready {
            options,
            selected,
            note,
        } => {
            *state.mode_mut() = Mode::Effort(Box::new(EffortPickerState {
                options,
                selected,
                note,
            }));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "effort_tests.rs"]
mod tests;
