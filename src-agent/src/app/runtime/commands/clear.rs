//! Clear command: `/clear` — wipe the live chat transcript, keep system + archive.

use anyhow::Result;

use crate::app::runtime::stream::abort_current;
use crate::app::state::AppState;
use crate::model::msglog;

/// Handle `/clear`: destructively empty the live conversation so the session
/// starts fresh, without opening a new session.
///
/// Kept:
/// - system prompt at `messages[0]` (rebuilt fresh after the cut)
/// - `messages.sqlite` archive rows (`messages` / `blobs` tables)
/// - project memory, `session_system_extra`, and an approved mission
///
/// Cleared / rewritten:
/// - every non-system turn in the live `Conversation` + `messages.json`
/// - the kickoff charter, session goal, and objective fingerprint, so the
///   next turn does not resume the previous task
/// - short-send rolling summary (empty text + watermark frozen at archive tip
///   so the reshaper cannot re-inject pre-clear history into a fresh chat)
/// - transcript cache / scroll (so the empty chat renders immediately)
///
/// Mid-stream: aborts the in-flight turn first (same full cancel as rewind),
/// then cuts — otherwise a late stream event could re-append onto a cleared
/// history.
pub(crate) fn handle_clear(state: &mut AppState) -> Result<()> {
    if state.rest.fg().session.is_none() {
        state.rest.fg_mut().status = "no active session".into();
        return Ok(());
    }

    // Full round teardown if anything is in flight (stream / approvals / subs).
    if state.rest.fg().waiting {
        abort_current(&mut state.rest);
        state.rest.fg_mut().waiting = false;
    }

    let Some(sess) = state.rest.fg_mut().session.as_mut() else {
        crate::model::store::append_global_error_log("clear", "BUG: fg session missing");
        return Ok(());
    };
    // Drop user/assistant/tool turns; keep system if present.
    sess.conversation.clear_body();
    // Re-seed / refresh the live system prompt (embedded + MEMORY.md etc.).
    sess.rebuild_system();
    // The archive stays. The objective must not: a greeting does not replace
    // a charter, so leaving it here makes the next "hello?" resume the old task.
    crate::app::runtime::shortsend::wipe_chat_doctrine(&mut sess.settings);
    let _ = sess.save();
    let session_dir = sess.path.clone();

    // Freeze short-send at the archive tip without deleting message/blob rows.
    let _ = msglog::clear_rolling_summary(&session_dir);

    // Transient UI flush: force next paint to rebuild blocks; stick to bottom of
    // the (now empty-of-turns) transcript. Cache is a single global scratch
    // (same pattern as compaction).
    state.rest.transcript_cache.borrow_mut().blocks.clear();
    {
        let fg = state.rest.fg_mut();
        fg.follow = true;
        fg.scroll = 0;
        fg.status = "chat cleared".into();
        // Clear loaded skill bodies so they don't persist across /clear.
        fg.active_skills.clear();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::mode::Mode;
    use crate::app::state::AppState;
    use crate::dto::chat::Role;
    use crate::model::conversation::Conversation;
    use crate::model::session::Session;
    use crate::model::settings::Settings;

    #[test]
    fn clear_drops_the_objective_and_keeps_sqlite_rows() {
        let path = std::env::temp_dir().join(format!("koma-clear-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        crate::model::msglog::append(
            &path,
            Role::User,
            "investigate the repo for vulnerabilities",
            None,
            None,
        )
        .unwrap();
        let before = crate::model::msglog::max_message_id(&path);
        assert!(before >= 1);
        let mut settings = Settings::default();
        settings.session_charter = "investigate the repo for vulnerabilities".into();
        settings.session_goal = "survey the structure".into();
        settings.session_goal_source = "user".into();
        settings.session_goal_msg_id = 1;
        settings.session_objective_fp = "user:survey the structure".into();
        settings.session_system_extra = "keep this suffix".into();
        let mut state = AppState::new(Mode::Chat);
        state.rest.fg_mut().session = Some(Session::new(
            "clear-test".into(),
            path.clone(),
            "clear-test".into(),
            settings,
            Conversation::new("system"),
        ));
        handle_clear(&mut state).unwrap();
        let sess = state.rest.fg().session.as_ref().unwrap();
        assert!(sess.settings.session_charter.is_empty());
        assert!(sess.settings.session_goal.is_empty());
        assert_eq!(sess.settings.session_goal_source, "none");
        assert_eq!(sess.settings.session_goal_msg_id, 0);
        assert!(sess.settings.session_objective_fp.is_empty());
        assert_eq!(sess.settings.session_system_extra, "keep this suffix");
        assert_eq!(sess.conversation.messages().len(), 1);
        assert_eq!(crate::model::msglog::max_message_id(&path), before);
        let _ = std::fs::remove_dir_all(&path);
    }
}
