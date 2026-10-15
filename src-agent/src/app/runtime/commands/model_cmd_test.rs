#![allow(clippy::unwrap_used, clippy::expect_used)]

use super::*;

#[test]
fn parse_role_main() {
    assert_eq!(parse_role("main"), Some(ModelRole::Main));
    assert_eq!(parse_role("Main"), Some(ModelRole::Main));
    assert_eq!(parse_role("MAIN"), Some(ModelRole::Main));
}

#[test]
fn parse_role_awareness() {
    assert_eq!(parse_role("awareness"), Some(ModelRole::Awareness));
    assert_eq!(parse_role("Awareness"), Some(ModelRole::Awareness));
}

#[test]
fn parse_role_planner() {
    assert_eq!(parse_role("planner"), Some(ModelRole::Planner));
}

#[test]
fn parse_role_compactor() {
    assert_eq!(parse_role("compactor"), Some(ModelRole::Compactor));
}

#[test]
fn parse_role_safeguard() {
    assert_eq!(parse_role("safeguard"), Some(ModelRole::Safeguard));
}

#[test]
fn parse_role_unknown() {
    assert_eq!(parse_role("unknown"), None);
    assert_eq!(parse_role(""), None);
    assert_eq!(parse_role("mainn"), None);
    assert_eq!(parse_role(" main"), None);
}

#[test]
fn bare_model_is_a_role_picker_and_explicit_help_still_opens_docs() {
    let mut state = AppState::new(crate::app::mode::Mode::Chat);
    handle_model(String::new(), &mut state).unwrap();
    let crate::app::mode::Mode::Model(m) = state.mode() else {
        panic!()
    };
    assert!(matches!(m.sub, ModelCmdSub::RoleList));
    assert_eq!(
        m.options
            .iter()
            .map(|(id, _)| id.as_deref().unwrap())
            .collect::<Vec<_>>(),
        vec!["main", "awareness", "planner", "compactor", "safeguard"]
    );
    handle_model("help".into(), &mut state).unwrap();
    assert!(
        matches!(state.mode(),crate::app::mode::Mode::Model(m) if matches!(m.sub,ModelCmdSub::Help {..}))
    );
}
