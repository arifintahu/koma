#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

#[test]
fn model_cmd_state_up_clamps() {
    let mut state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![
            (None, "inherit".to_string()),
            (Some("a".into()), "model-a".to_string()),
        ],
        cursor: 1,
        note: String::new(),
    };
    state.up();
    assert_eq!(state.cursor, 0);
    state.up(); // Already at 0, should clamp.
    assert_eq!(state.cursor, 0);
}

#[test]
fn model_cmd_state_down_clamps() {
    let mut state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![
            (None, "inherit".to_string()),
            (Some("a".into()), "model-a".to_string()),
        ],
        cursor: 0,
        note: String::new(),
    };
    state.down();
    assert_eq!(state.cursor, 1);
    state.down(); // Already at last, should clamp.
    assert_eq!(state.cursor, 1);
}

#[test]
fn model_cmd_state_selected() {
    let state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![
            (None, "inherit".to_string()),
            (Some("a".into()), "model-a".to_string()),
        ],
        cursor: 1,
        note: String::new(),
    };
    let sel = state.selected().unwrap();
    assert_eq!(sel.0.as_deref(), Some("a"));
    assert_eq!(sel.1, "model-a");
}

#[test]
fn model_cmd_state_selected_uuid_none() {
    let state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![(None, "inherit".to_string())],
        cursor: 0,
        note: String::new(),
    };
    assert_eq!(state.selected_uuid(), None);
}

#[test]
fn model_cmd_state_selected_uuid_some() {
    let state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![(Some("uuid-42".into()), "m".to_string())],
        cursor: 0,
        note: String::new(),
    };
    assert_eq!(state.selected_uuid(), Some("uuid-42".to_string()));
}

#[test]
fn model_cmd_state_empty_options() {
    let mut state = ModelCmdState {
        query: String::new(),
        from_roles: false,
        sub: ModelCmdSub::Help { lines: vec![] },
        options: vec![],
        cursor: 0,
        note: String::new(),
    };
    state.up();
    assert_eq!(state.cursor, 0);
    state.down();
    assert_eq!(state.cursor, 0);
    assert!(state.selected().is_none());
    assert_eq!(state.selected_uuid(), None);
}

#[test]
fn search_preserves_canonical_options_and_selects_the_filtered_uuid() {
    let mut state = ModelCmdState {
        sub: ModelCmdSub::RolePick {
            role: ModelRole::Planner,
        },
        query: String::new(),
        from_roles: false,
        options: vec![
            (None, "(inherit global)".into()),
            (Some("one".into()), "Small — alpha @ Local".into()),
            (Some("two".into()), "Large — beta @ Remote".into()),
        ],
        cursor: 2,
        note: String::new(),
    };
    state.set_query("REMOTE beta".into());
    assert_eq!(state.filtered_indices(), vec![2]);
    assert_eq!(state.selected_uuid().as_deref(), Some("two"));
    state.down();
    assert_eq!(state.cursor, 0);
    assert_eq!(state.options.len(), 3);
    state.set_query("no matching model".into());
    assert!(state.selected().is_none());
    state.set_query(String::new());
    state.down();
    assert_eq!(state.selected_uuid().as_deref(), Some("one"));
}
