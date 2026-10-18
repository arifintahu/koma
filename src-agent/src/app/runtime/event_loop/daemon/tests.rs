//! Hub drive proof: exercise the hub with NO socket and assert (a) the seq'd
//! frame stream — a Snapshot on attach, then a Delta on the next state change
//! with `seq = N+1` (stage 4), and (b) that a controller's mutating request is
//! actually applied through the shared action path, single-writer is enforced,
//! the controller seat passes on detach, and QuitDaemon latches shutdown
//! (stage 5). These stand in for the accept loop so the full drive path is
//! covered without a real socket.

use super::*;
use crate::app::mode::Mode;
use crate::ipc::proto::{
    key_mods, ClientRequest, DaemonEvent, DaemonFrame, KeyCodeWire, KeyWire, StateDelta,
};

/// A keyless client + a current-thread tokio runtime — the minimal context the
/// mutating-request path needs. `client = None` means a `Submit`/`Resend`-style
/// action short-circuits to "no active session" (still `Ok`, so still `Ack`),
/// while a `SendKey` editing the composer mutates `state` with no client at all.
fn ctx() -> (Option<Arc<OpenRouterClient>>, tokio::runtime::Runtime) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .build()
        .expect("build test runtime");
    (None, rt)
}

/// Attaching a client yields a `Snapshot{seq=1}`; a subsequent status change
/// yields a `Delta{seq=2}` carrying the new global status.
#[test]
fn attach_then_change_emits_snapshot_then_seqd_delta() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::Attach {
                foreground_id: None,
                cwd: None,
            },
        },
        &mut state,
        &mut client,
        &h,
    );

    let f0 = frame_rx.try_recv().expect("hello frame on attach");
    assert_eq!(f0.seq, 1, "first frame seq");
    assert!(
        matches!(f0.event, DaemonEvent::Hello { .. }),
        "attach emits Hello first, got {:?}",
        f0.event
    );
    let f1 = frame_rx.try_recv().expect("snapshot frame on attach");
    assert_eq!(f1.seq, 2, "snapshot follows hello");
    assert!(
        matches!(f1.event, DaemonEvent::Snapshot(_)),
        "attach emits a Snapshot after Hello, got {:?}",
        f1.event
    );

    state.rest.fg_mut().status = "streaming".into();
    hub.stream_deltas(&mut state);
    let f2 = frame_rx.try_recv().expect("delta frame after change");
    assert_eq!(f2.seq, 3, "delta seq is N+1");
    match f2.event {
        DaemonEvent::Delta(StateDelta::StatusChanged { session_id, text }) => {
            assert_eq!(session_id, None, "global status delta");
            assert_eq!(text, "streaming");
        }
        other => panic!("expected StatusChanged delta, got {other:?}"),
    }

    hub.stream_deltas(&mut state);
    assert!(
        frame_rx.try_recv().is_err(),
        "no frame emitted when state is unchanged"
    );
}

/// A structural change (a session entering tool-approval) resyncs with a full
/// `Snapshot`, not a partial delta.
#[test]
fn structural_change_emits_full_snapshot() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 7,
            frame_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 7,
            req: ClientRequest::Attach {
                foreground_id: None,
                cwd: None,
            },
        },
        &mut state,
        &mut client,
        &h,
    );
    let _hello = frame_rx.try_recv().expect("attach hello");
    let _snap = frame_rx.try_recv().expect("attach snapshot");

    state.rest.fg_mut().awaiting_approval = true;
    hub.stream_deltas(&mut state);
    let f = frame_rx.try_recv().expect("frame after structural change");
    assert_eq!(f.seq, 3);
    assert!(
        matches!(f.event, DaemonEvent::Snapshot(_)),
        "structural change must resync with a full Snapshot, got {:?}",
        f.event
    );
}

/// Build-skew handshake (task #142): an attaching client's VERY FIRST frame is a
/// `Hello` carrying the hub's stored fingerprint, ahead of the initial Snapshot.
#[test]
fn attach_emits_hello_then_snapshot() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (frame_tx, frame_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::Attach {
                foreground_id: None,
                cwd: None,
            },
        },
        &mut state,
        &mut client,
        &h,
    );

    let f0 = frame_rx.try_recv().expect("hello frame on attach");
    assert_eq!(f0.seq, 1);
    match f0.event {
        DaemonEvent::Hello { version, protocol, capabilities } => {
            assert_eq!(protocol, crate::ipc::proto::IPC_PROTOCOL_VERSION);
            assert_eq!(capabilities, vec!["submit_turn", "interrupt_turn", "session_policy"]);
            assert_eq!(
                version,
                crate::model::store::build_fingerprint(),
                "Hello carries the hub's stored fingerprint"
            );
        }
        other => panic!("expected Hello first, got {other:?}"),
    }
    let f1 = frame_rx.try_recv().expect("snapshot frame after hello");
    assert_eq!(f1.seq, 2);
    assert!(matches!(f1.event, DaemonEvent::Snapshot(_)));
}

/// C2: observers may now submit against their own foreground (the single-writer
/// gate was relaxed). Both controller and observer get an Ack.
#[test]
fn observer_mutation_is_allowed_controller_acked() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (ctl_tx, ctl_rx) = std::sync::mpsc::channel::<DaemonFrame>();
    let (obs_tx, obs_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: ctl_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Register {
            client_id: 2,
            frame_tx: obs_tx,
        },
        &mut state,
        &mut client,
        &h,
    );

    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::SubmitInput { text: "hi".into() },
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(matches!(
        ctl_rx.try_recv().expect("controller reply").event,
        DaemonEvent::Ack
    ));

    hub.handle_inbound(
        HubInbound::Request {
            client_id: 2,
            req: ClientRequest::SubmitInput {
                text: "nope".into(),
            },
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(matches!(
        obs_rx.try_recv().expect("observer reply").event,
        DaemonEvent::Ack
    ));
}

/// An unknown session UUID on a UUID-keyed control request is an Error + no-op.
#[test]
fn unknown_session_uuid_errors_not_panics() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, rx) = std::sync::mpsc::channel::<DaemonFrame>();
    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::SwitchForeground {
                session_id: "does-not-exist".into(),
            },
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(matches!(
        rx.try_recv().expect("reply").event,
        DaemonEvent::Error(_)
    ));
}

/// A controller's `SendKey` is routed through the SAME local input pipeline.
#[test]
fn controller_sendkey_edits_composer() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::SendKey(KeyWire {
                code: KeyCodeWire::Char('z'),
                mods: 0,
            }),
        },
        &mut state,
        &mut client,
        &h,
    );

    assert_eq!(
        state.rest.fg().input,
        "z",
        "key reached the composer via apply_action"
    );
    assert!(matches!(
        rx.try_recv().expect("reply").event,
        DaemonEvent::Ack
    ));
}

/// When the controller detaches, the seat passes to the next remaining client.
#[test]
fn controller_seat_passes_on_detach() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (c1_tx, _c1_rx) = std::sync::mpsc::channel::<DaemonFrame>();
    let (c2_tx, c2_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: c1_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Register {
            client_id: 2,
            frame_tx: c2_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::Detach,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 2,
            req: ClientRequest::SendKey(KeyWire {
                code: KeyCodeWire::Char('q'),
                mods: key_mods::CONTROL,
            }),
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(matches!(
        c2_rx.try_recv().expect("promoted controller reply").event,
        DaemonEvent::Ack
    ));
}

/// `QuitDaemon` from the controller latches the shutdown flag the loop polls.
#[test]
fn quit_daemon_latches_shutdown() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(
        !hub.should_shutdown(),
        "shutdown not latched before QuitDaemon"
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::QuitDaemon,
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(hub.should_shutdown(), "QuitDaemon latches shutdown");
    assert!(matches!(
        rx.try_recv().expect("reply").event,
        DaemonEvent::Ack
    ));
}

/// A `Disconnect` (socket EOF) deregisters the client and passes the controller seat.
#[test]
fn disconnect_deregisters_and_passes_seat() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (c1_tx, _c1_rx) = std::sync::mpsc::channel::<DaemonFrame>();
    let (c2_tx, c2_rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: c1_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Register {
            client_id: 2,
            frame_tx: c2_tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Disconnect { client_id: 1 },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 2,
            req: ClientRequest::SubmitInput { text: "x".into() },
        },
        &mut state,
        &mut client,
        &h,
    );
    assert!(matches!(
        c2_rx.try_recv().expect("promoted controller reply").event,
        DaemonEvent::Ack
    ));
}

// ─── daemon stage 10: tombstone close + self-exit ────────────────────────

use crate::app::state::SessionRuntime;

/// Append a fresh (live) session to `state` and return its stable id.
fn push_session(state: &mut AppState) -> String {
    let rt = SessionRuntime::new();
    let id = rt.id.clone();
    state.rest.sessions.push(rt);
    id
}

/// `QuitSession` on a known id TOMBSTONES that session and Acks; the other stays live.
#[test]
fn quit_session_tombstones_keeps_slot_and_acks() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, rx) = std::sync::mpsc::channel::<DaemonFrame>();

    let id1 = push_session(&mut state);
    let id0 = state.rest.sessions[0].id.clone();
    let len_before = state.rest.sessions.len();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::QuitSession {
                session_id: id1.clone(),
            },
        },
        &mut state,
        &mut client,
        &h,
    );

    assert!(matches!(
        rx.try_recv().expect("reply").event,
        DaemonEvent::Ack
    ));
    assert_eq!(
        state.rest.sessions.len(),
        len_before,
        "tombstone keeps the slot"
    );
    let s1 = state
        .rest
        .sessions
        .iter()
        .find(|s| s.id == id1)
        .expect("slot kept");
    assert!(s1.closed, "quit session is tombstoned");
    let s0 = state
        .rest
        .sessions
        .iter()
        .find(|s| s.id == id0)
        .expect("other slot");
    assert!(!s0.closed, "the other session stays live");
}

/// `QuitSession` on an unknown id is an Error + no-op.
#[test]
fn quit_session_unknown_id_errors_no_close() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, rx) = std::sync::mpsc::channel::<DaemonFrame>();

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::QuitSession {
                session_id: "nope".into(),
            },
        },
        &mut state,
        &mut client,
        &h,
    );

    assert!(matches!(
        rx.try_recv().expect("reply").event,
        DaemonEvent::Error(_)
    ));
    assert!(
        state.rest.sessions.iter().all(|s| !s.closed),
        "no session closed on unknown id"
    );
}

/// Closing the FOREGROUND session repoints `foreground` onto a still-live one.
#[test]
fn quit_foreground_repoints_to_live_session() {
    let mut state = AppState::new(Mode::Chat);
    let (mut client, rt) = ctx();
    let h = rt.handle().clone();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (tx, _rx) = std::sync::mpsc::channel::<DaemonFrame>();

    let id1 = push_session(&mut state);
    state.rest.foreground = 1;

    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx: tx,
        },
        &mut state,
        &mut client,
        &h,
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::QuitSession { session_id: id1 },
        },
        &mut state,
        &mut client,
        &h,
    );

    assert_eq!(
        state.rest.foreground, 0,
        "foreground repointed to the live session"
    );
    assert!(!state.rest.fg().closed, "foreground is a live session");
}

/// A CLOSED session is SKIPPED by `service_all_sessions`.
#[test]
fn closed_session_is_skipped_by_servicer() {
    let mut state = AppState::new(Mode::Chat);
    let (client, rt) = ctx();
    let h = rt.handle().clone();

    let (ev_tx, ev_rx) = tokio::sync::mpsc::unbounded_channel::<crate::service::StreamEvent>();
    ev_tx
        .send(crate::service::StreamEvent::Token("hi".into()))
        .expect("queue a token");
    state.rest.sessions[0].active_rx = Some(ev_rx);
    state.rest.sessions[0].begin_stream();
    state.rest.sessions[0].closed = true;

    let _ = service_all_sessions(&mut state, &client, &h);

    assert_eq!(
        state.rest.sessions[0].streaming.as_deref(),
        Some(""),
        "closed session was skipped: its streaming buffer stayed empty"
    );
    assert!(
        state.rest.sessions[0].active_rx.is_some(),
        "closed session was skipped: its receiver was never taken/drained"
    );
    drop(ev_tx);
}

/// `close_all_sessions` tombstones every session; `all_sessions_closed` then reports true.
#[test]
fn close_all_then_all_closed_true() {
    let mut state = AppState::new(Mode::Chat);
    let _id1 = push_session(&mut state);
    let _id2 = push_session(&mut state);
    assert!(!all_sessions_closed(&state), "not closed before kill-all");

    // `close_all_sessions` is now a method on the hub (C1.5: it also repoints the
    // per-client foreground pointers). With no clients enrolled the per-client repoint
    // is a no-op, so the `state` outcome asserted here is identical to before.
    let (mut hub, _runner_tx) = DaemonHub::new();
    hub.close_all_sessions(&mut state);

    assert!(
        all_sessions_closed(&state),
        "every session closed after kill-all"
    );
    assert!(
        state.rest.sessions.iter().all(|s| !s.is_working()),
        "no tombstone reads as working"
    );
}

/// The daemon-side `should_quit` sweep simulation (daemon/mod.rs ~363-366): a
/// landing/onboarding `request_quit` (or any other daemon-side path) setting
/// `state.rest.should_quit` must latch a REAL daemon shutdown — the same flag
/// `ClientRequest::QuitDaemon` sets — not merely close sessions with nothing left
/// to break the loop or unlink the socket.
#[test]
fn should_quit_flag_drives_shutdown() {
    let mut state = AppState::new(Mode::Chat);
    let _id1 = push_session(&mut state);
    let (mut hub, _runner_tx) = DaemonHub::new();

    state.rest.should_quit = true;
    assert!(!hub.should_shutdown(), "not yet latched before the sweep");

    if state.rest.should_quit {
        state.rest.should_quit = false;
        hub.request_shutdown();
    }

    assert!(!state.rest.should_quit, "flag cleared by the sweep");
    assert!(
        hub.should_shutdown(),
        "sweep latches the same flag QuitDaemon sets"
    );
}

// ─── daemon stage 11: detached-approval park timeout + parked cadence ─────

/// Put session `idx` into the PARKED-on-approval state with one unanswered risky tool call.
fn park_on_approval(state: &mut AppState, idx: usize) {
    use crate::dto::chat::{FunctionCall, ToolCall};
    let s = &mut state.rest.sessions[idx];
    s.waiting = true;
    s.awaiting_approval = true;
    s.approval_reason = Some("writes outside workspace".into());
    s.pending_tool_calls = vec![ToolCall {
        id: "call-1".into(),
        kind: "function".into(),
        function: FunctionCall {
            name: "bash".into(),
            arguments: "{}".into(),
        },
    }];
    s.tool_idx = 0;
}

/// Detached + awaiting: the first pass STAMPS the park timer but does NOT deny before the window elapses.
#[test]
fn park_timer_stamps_when_detached_no_premature_deny() {
    let mut state = AppState::new(Mode::Chat);
    park_on_approval(&mut state, 0);
    assert!(
        state.rest.sessions[0].park_started_at.is_none(),
        "no timer yet"
    );

    let denied = service_approval_park_timeouts(&mut state, false);

    assert!(!denied, "nothing denied on the first detached tick");
    assert!(
        state.rest.sessions[0].park_started_at.is_some(),
        "the park timer is stamped on the first detached+awaiting tick"
    );
    assert!(
        state.rest.sessions[0].awaiting_approval,
        "still parked — the window has not elapsed"
    );
}

/// While a client IS attached, the timer never runs.
#[test]
fn park_timer_cleared_while_client_attached() {
    let mut state = AppState::new(Mode::Chat);
    park_on_approval(&mut state, 0);
    state.rest.sessions[0].park_started_at = Some(Instant::now());

    let denied = service_approval_park_timeouts(&mut state, true);

    assert!(!denied, "an attached operator is never auto-denied");
    assert!(
        state.rest.sessions[0].park_started_at.is_none(),
        "the timer is cleared while a client is attached"
    );
    assert!(
        state.rest.sessions[0].awaiting_approval,
        "still parked, waiting for the operator"
    );
}

/// Once a DETACHED park exceeds `APPROVAL_PARK_TIMEOUT`, the pending call is auto-denied.
#[test]
fn park_timeout_auto_denies_after_window() {
    let mut state = AppState::new(Mode::Chat);
    park_on_approval(&mut state, 0);
    let past = Instant::now()
        .checked_sub(APPROVAL_PARK_TIMEOUT + Duration::from_secs(1))
        .expect("instant far enough in the past");
    state.rest.sessions[0].park_started_at = Some(past);

    let denied = service_approval_park_timeouts(&mut state, false);

    assert!(denied, "the expired park was auto-denied");
    let s = &state.rest.sessions[0];
    assert!(!s.awaiting_approval, "auto-deny clears the approval park");
    assert!(
        s.pending_tool_calls.is_empty(),
        "pending calls were answered/drained"
    );
    assert!(!s.waiting, "the session goes idle after the auto-deny");
    assert!(
        s.park_started_at.is_none(),
        "the park timer is cleared after the deny"
    );
}

/// A session that is NOT awaiting approval has its timer cleared every pass.
#[test]
fn park_timer_reset_when_not_awaiting() {
    let mut state = AppState::new(Mode::Chat);
    state.rest.sessions[0].park_started_at = Some(Instant::now());
    state.rest.sessions[0].awaiting_approval = false;

    let denied = service_approval_park_timeouts(&mut state, false);

    assert!(!denied, "an idle session is never denied");
    assert!(
        state.rest.sessions[0].park_started_at.is_none(),
        "a non-awaiting session's timer is cleared"
    );
}

/// A CLOSED session is ignored by the park timer.
#[test]
fn park_timeout_skips_closed_session() {
    let mut state = AppState::new(Mode::Chat);
    park_on_approval(&mut state, 0);
    let stamp = Instant::now()
        .checked_sub(APPROVAL_PARK_TIMEOUT + Duration::from_secs(1))
        .expect("past instant");
    state.rest.sessions[0].park_started_at = Some(stamp);
    state.rest.sessions[0].closed = true;

    let denied = service_approval_park_timeouts(&mut state, false);

    assert!(!denied, "a closed session is skipped, never auto-denied");
    assert!(
        state.rest.sessions[0].park_started_at.is_some(),
        "a closed session's fields are left untouched"
    );
}

/// Cadence predicate: detached + parked-on-approval → slow; attached → fast.
#[test]
fn cadence_slow_when_parked_detached_fast_when_attached() {
    let mut state = AppState::new(Mode::Chat);
    park_on_approval(&mut state, 0);

    assert!(
        all_idle_or_parked_detached(&state, false),
        "detached + parked-on-approval should nap on the slow cadence"
    );
    assert!(
        !all_idle_or_parked_detached(&state, true),
        "an attached client over a parked session keeps the fast cadence"
    );
}

/// Cadence predicate: a streaming session keeps the daemon fast.
#[test]
fn cadence_fast_when_session_streaming() {
    let mut state = AppState::new(Mode::Chat);
    state.rest.sessions[0].begin_stream();

    assert!(
        !all_idle_or_parked_detached(&state, false),
        "a streaming session keeps the daemon on the fast cadence (detached)"
    );
    assert!(
        !all_idle_or_parked_detached(&state, true),
        "a streaming session keeps the daemon on the fast cadence (attached)"
    );
}

/// Cadence predicate: a fully idle daemon naps slow.
#[test]
fn cadence_slow_when_fully_idle() {
    let state = AppState::new(Mode::Chat);
    assert!(
        all_idle_or_parked_detached(&state, false),
        "idle + detached naps slow"
    );
    assert!(
        all_idle_or_parked_detached(&state, true),
        "idle + an attached-but-quiet client still naps slow"
    );
}

#[test]
fn setup_menu_exit_is_correlated_and_navigation_does_not_quit() {
    use crate::ipc::proto::MenuAction;
    for (code, mods, exits) in [
        (KeyCodeWire::Esc, 0, true),
        (KeyCodeWire::Char('q'), 0, true),
        (KeyCodeWire::Char('c'), key_mods::CONTROL, true),
        (KeyCodeWire::Down, 0, false),
    ] {
        let mut state = AppState::new(Mode::Onboard(Box::default()));
        let (mut client, rt) = ctx();
        let (mut hub, runner_tx) = DaemonHub::new();
        let (frame_tx, frame_rx) = std::sync::mpsc::channel();
        hub.handle_inbound(
            HubInbound::Register {
                client_id: 1,
                frame_tx,
            },
            &mut state,
            &mut client,
            rt.handle(),
        );
        hub.handle_inbound(
            HubInbound::Request {
                client_id: 1,
                req: ClientRequest::Attach {
                    foreground_id: None,
                    cwd: None,
                },
            },
            &mut state,
            &mut client,
            rt.handle(),
        );
        hub.handle_inbound(
            HubInbound::Request {
                client_id: 1,
                req: ClientRequest::Menu {
                    request_id: "setup-key".into(),
                    mode: "Onboard".into(),
                    action: MenuAction::Key(KeyWire { code, mods }),
                },
            },
            &mut state,
            &mut client,
            rt.handle(),
        );
        assert!(frame_rx.try_iter().any(|frame| matches!(frame.event,
            DaemonEvent::MenuResult { request_id, error: None, exit } if request_id == "setup-key" && exit == exits)));
        assert_eq!(state.rest.should_quit, exits);
        if exits {
            runner_tx
                .send(HubInbound::Request {
                    client_id: 1,
                    req: ClientRequest::Detach,
                })
                .unwrap();
            hub.flush_exit_response();
            hub.flush_exit_response();
        }
    }
}

#[test]
fn setup_enter_and_nested_escape_keep_the_wizard_usable() {
    use crate::app::mode::OnboardState;
    use crate::ipc::proto::MenuAction;
    let mut state = AppState::new(Mode::Onboard(Box::new(OnboardState { cursor: 2 })));
    let (mut client, rt) = ctx();
    let (mut hub, _runner_tx) = DaemonHub::new();
    let (frame_tx, frame_rx) = std::sync::mpsc::channel();
    hub.handle_inbound(
        HubInbound::Register {
            client_id: 1,
            frame_tx,
        },
        &mut state,
        &mut client,
        rt.handle(),
    );
    hub.handle_inbound(
        HubInbound::Request {
            client_id: 1,
            req: ClientRequest::Attach {
                foreground_id: None,
                cwd: None,
            },
        },
        &mut state,
        &mut client,
        rt.handle(),
    );
    for (mode, code, exit) in [
        ("Onboard", KeyCodeWire::Enter, false),
        ("KeyInput", KeyCodeWire::Enter, false),
        ("KeyInput", KeyCodeWire::Esc, false),
        ("KeyInput", KeyCodeWire::Esc, true),
    ] {
        hub.handle_inbound(
            HubInbound::Request {
                client_id: 1,
                req: ClientRequest::Menu {
                    request_id: mode.into(),
                    mode: mode.into(),
                    action: MenuAction::Key(KeyWire { code, mods: 0 }),
                },
            },
            &mut state,
            &mut client,
            rt.handle(),
        );
        assert!(frame_rx.try_iter().any(|frame| matches!(frame.event,
            DaemonEvent::MenuResult { error: None, exit: requested, .. } if requested == exit)));
        assert!(matches!(state.mode(), Mode::KeyInput(_)));
        assert_eq!(state.rest.should_quit, exit);
    }
}

/// In-process hub fixture: current-thread tasks never contact a model provider.
struct TurnFixture {
    state: AppState,
    client: Option<Arc<OpenRouterClient>>,
    runtime: tokio::runtime::Runtime,
    hub: DaemonHub,
    replies: Vec<std::sync::mpsc::Receiver<DaemonFrame>>,
    path: std::path::PathBuf,
}

impl TurnFixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("koma-ipc-turn-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        let session = crate::model::session::Session::new(
            uuid::Uuid::new_v4().to_string(), path.clone(), "ipc-test".into(),
            crate::model::settings::Settings::default(),
            crate::model::conversation::Conversation::new("test"),
        );
        let mut state = AppState::new(Mode::Chat);
        state.rest.fg_mut().session = Some(session);
        let (hub, _) = DaemonHub::new();
        let mut fixture = Self {
            state, client: Some(Arc::new(OpenRouterClient::new())),
            runtime: tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap(),
            hub, replies: Vec::new(), path,
        };
        for client_id in [1, 2] {
            let (frame_tx, frame_rx) = std::sync::mpsc::channel();
            fixture.hub.handle_inbound(HubInbound::Register { client_id, frame_tx },
                &mut fixture.state, &mut fixture.client, fixture.runtime.handle());
            fixture.replies.push(frame_rx);
            fixture.request(client_id, ClientRequest::Attach { foreground_id: None, cwd: None });
            fixture.replies[(client_id - 1) as usize].try_iter().for_each(drop);
        }
        fixture
    }

    fn request(&mut self, client_id: u64, req: ClientRequest) {
        self.hub.handle_inbound(HubInbound::Request { client_id, req },
            &mut self.state, &mut self.client, self.runtime.handle());
    }

    fn result(&self) -> DaemonEvent {
        self.replies[0].try_recv().expect("requester reply").event
    }
}

impl Drop for TurnFixture {
    fn drop(&mut self) {
        self.state.rest.fg_mut().interrupt();
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
fn tracked_submit_starts_once_rejects_busy_and_never_broadcasts() {
    use crate::ipc::proto::turn::{TurnDisposition, TurnState};
    let mut f = TurnFixture::new();
    f.request(1, ClientRequest::SubmitTurn { request_id: "first".into(), text: "hello".into() });
    let id = match f.result() {
        DaemonEvent::TurnResult { request_id, disposition: TurnDisposition::Started, turn_id: Some(id), reason: None } => {
            assert_eq!(request_id, "first");
            id
        }
        other => panic!("expected started, got {other:?}"),
    };
    assert_eq!(f.state.rest.fg().active_turn.as_ref().unwrap().id, id);
    assert_eq!(f.state.rest.fg().active_turn.as_ref().unwrap().state, TurnState::Running);
    f.request(1, ClientRequest::SubmitTurn { request_id: "busy".into(), text: "not a steer".into() });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, .. }));
    assert!(f.state.rest.fg().pending_steer.is_empty());
    f.request(1, ClientRequest::SubmitInput { text: "legacy steer".into() });
    assert_eq!(f.result(), DaemonEvent::Ack);
    assert_eq!(f.state.rest.fg().pending_steer.len(), 1);
    f.hub.stream_deltas(&mut f.state);
    assert!(!f.replies[1].try_iter().any(|frame| matches!(frame.event, DaemonEvent::TurnResult { .. })));
}

#[test]
fn targeted_interrupt_rejects_stale_id_while_unit_interrupt_still_cuts() {
    use crate::ipc::proto::turn::{TurnDisposition, TurnState};
    let mut f = TurnFixture::new();
    let id = f.state.rest.fg_mut().begin_turn();
    f.state.rest.fg_mut().waiting = true;
    f.request(1, ClientRequest::InterruptTurn { request_id: "stale".into(), turn_id: "older".into() });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, reason: Some(reason), .. } if reason == "stale_turn"));
    assert!(f.state.rest.fg().waiting);
    assert_eq!(f.state.rest.fg().active_turn.as_ref().unwrap().id, id);
    f.request(1, ClientRequest::InterruptTurn { request_id: "stop".into(), turn_id: id.clone() });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Interrupted, turn_id: Some(actual), .. } if actual == id));
    assert!(!f.state.rest.fg().waiting);
    assert_eq!(f.state.rest.fg().last_turn.as_ref().unwrap().state, TurnState::Interrupted);
    f.state.rest.fg_mut().begin_turn();
    f.state.rest.fg_mut().waiting = true;
    f.request(1, ClientRequest::Interrupt);
    assert_eq!(f.result(), DaemonEvent::Ack);
    assert!(f.state.rest.fg().active_turn.is_none());
    assert!(!f.state.rest.fg().waiting);
    assert!(f.replies[1].try_recv().is_err());
}

#[test]
fn tracked_submit_rejects_empty_and_shell_or_approval_parks() {
    use crate::ipc::proto::turn::TurnDisposition;
    let mut f = TurnFixture::new();
    for (text, shell, approval) in [("  ", false, false), ("hello", true, false), ("hello", false, true)] {
        f.state.rest.fg_mut().awaiting_shell = shell;
        f.state.rest.fg_mut().awaiting_approval = approval;
        f.request(1, ClientRequest::SubmitTurn { request_id: "reject".into(), text: text.into() });
        assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, .. }));
        assert!(f.state.rest.fg().active_turn.is_none());
        assert!(f.state.rest.fg().pending_steer.is_empty());
    }
}

#[test]
fn session_policy_is_explicit_idle_only_and_persists_before_activation() {
    use crate::ipc::proto::turn::{PlanPolicy, ApprovalPolicy, SessionPolicy};
    let mut f = TurnFixture::new();
    let policy_request = || ClientRequest::SetSessionPolicy { request_id: "policy".into(), plan: PlanPolicy::Forbid, approval: ApprovalPolicy::Reject };
    f.state.rest.fg_mut().waiting = true;
    f.request(1, policy_request());
    assert!(matches!(f.result(), DaemonEvent::Error(_)));
    assert!(!f.path.join("unattended.json").exists());
    f.state.rest.fg_mut().waiting = false;
    f.state.rest.fg_mut().agent_mode = crate::app::state::AgentMode::Plan;
    f.request(1, policy_request());
    assert!(matches!(f.result(), DaemonEvent::Error(reason) if reason.contains("leave plan mode first")));
    f.state.rest.fg_mut().agent_mode = crate::app::state::AgentMode::Normal;
    f.request(1, policy_request());
    assert_eq!(f.result(), DaemonEvent::Ack);
    assert_eq!(f.state.rest.fg().policy, SessionPolicy { plan: PlanPolicy::Forbid, approval: ApprovalPolicy::Reject });
    let loaded = crate::model::session::Session::load(&f.path).unwrap();
    assert_eq!(loaded.unattended.policy, f.state.rest.fg().policy);
    assert!(f.replies[1].try_recv().is_err());
}

#[test]
fn tracked_submit_reports_synchronous_kickoff_failure_not_started() {
    use crate::ipc::proto::turn::{TurnDisposition, TurnState};
    let mut f = TurnFixture::new();
    f.state.rest.fg_mut().session.as_mut().unwrap().conversation =
        crate::model::conversation::Conversation::from_messages(Vec::new());
    f.request(1, ClientRequest::SubmitTurn { request_id: "bad-history".into(), text: "hello".into() });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, reason: Some(reason), .. } if reason.contains("leading system message")));
    assert!(!f.state.rest.fg().waiting);
    assert!(f.state.rest.fg().active_turn.is_none());
    assert_eq!(f.state.rest.fg().last_turn.as_ref().unwrap().state, TurnState::Failed);
}

#[test]
fn tracked_submit_save_failure_rejects_and_legacy_still_acks() {
    use crate::ipc::proto::turn::TurnDisposition;
    let mut f = TurnFixture::new();
    let blocked = f.path.join("not-a-directory");
    std::fs::write(&blocked, "file").unwrap();
    f.state.rest.fg_mut().session.as_mut().unwrap().path = blocked;
    f.request(1, ClientRequest::SubmitTurn { request_id: "save-fails".into(), text: "hello".into() });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, reason: Some(_), .. }));
    assert!(!f.state.rest.fg().waiting);
    assert!(f.state.rest.fg().active_turn.is_none());
    f.request(1, ClientRequest::SubmitInput { text: "legacy".into() });
    assert_eq!(f.result(), DaemonEvent::Ack);
}

#[test]
fn normal_final_answer_completes_old_id_before_queued_steer_starts_fresh() {
    use crate::ipc::proto::turn::{TurnDisposition, TurnState};
    let mut f = TurnFixture::new();
    let old_id = f.state.rest.fg_mut().begin_turn();
    f.state.rest.fg_mut().waiting = true;
    f.state.rest.fg_mut().streaming = Some("Implemented the requested change.".into());
    f.state.rest.fg_mut().pending_steer.push("Next request".to_string().into());
    crate::app::runtime::stream::advance_turn(&mut f.state, 0, &f.client, f.runtime.handle());
    let previous = f.state.rest.fg().last_turn.as_ref().unwrap();
    assert_eq!(previous.id, old_id);
    assert_eq!(previous.state, TurnState::Finished);
    let fresh = f.state.rest.fg().active_turn.as_ref().unwrap().id.clone();
    assert_ne!(fresh, old_id);
    f.request(1, ClientRequest::InterruptTurn { request_id: "late-stop".into(), turn_id: old_id });
    assert!(matches!(f.result(), DaemonEvent::TurnResult { disposition: TurnDisposition::Rejected, reason: Some(reason), .. } if reason == "stale_turn"));
    assert_eq!(f.state.rest.fg().active_turn.as_ref().unwrap().id, fresh);
}

#[test]
fn stream_failure_completes_addressed_session_without_touching_foreground() {
    use crate::ipc::proto::turn::TurnState;
    let mut f = TurnFixture::new();
    let fg_id = f.state.rest.fg_mut().begin_turn();
    let mut other = crate::app::state::SessionRuntime::new();
    let other_id = other.begin_turn();
    other.waiting = true;
    f.state.rest.sessions.push(other);
    crate::app::runtime::stream::finish_stream(&mut f.state.rest, 1, Some("producer disconnected".into()));
    assert_eq!(f.state.rest.fg().active_turn.as_ref().unwrap().id, fg_id);
    let completed = f.state.rest.sessions[1].last_turn.as_ref().unwrap();
    assert_eq!(completed.id, other_id);
    assert_eq!(completed.state, TurnState::Failed);
    assert_eq!(completed.error.as_deref(), Some("producer disconnected"));
}
