//! Controller – key handler for the `/model` command overlay.

use ratatui::crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use crate::app::mode::{ModelCmdState, ModelCmdSub};
use crate::controller::input::action::Action;

/// Handle a key press inside the `/model` command overlay.
///
/// Up/Down move the selection; Enter confirms the highlighted option (meaning
/// depends on submode); Esc cancels. `_rest` is accepted for handler-signature
/// consistency but unused here.
pub(crate) fn handle_model_cmd(
    m: &mut ModelCmdState,
    _rest: &mut crate::app::state::AppStateRest,
    key: KeyEvent,
) -> Action {
    match key.code {
        KeyCode::Esc => match &m.sub {
            ModelCmdSub::RolePick { .. } if m.from_roles => Action::ModelBackToRoles,
            ModelCmdSub::AgentPick { .. } => {
                // Esc in AgentPick → back to AgentList
                Action::ModelBackToAgentList
            }
            _ => Action::ModelCancel,
        },
        KeyCode::Up => {
            m.up();
            Action::None
        }
        KeyCode::Down => {
            m.down();
            Action::None
        }
        KeyCode::Char(c)
            if m.searchable()
                && !key
                    .modifiers
                    .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) =>
        {
            let mut query = m.query.clone();
            query.push(c);
            m.set_query(query);
            Action::None
        }
        KeyCode::Backspace if m.searchable() => {
            let mut query = m.query.clone();
            query.pop();
            m.set_query(query);
            Action::None
        }
        KeyCode::Enter if m.selected().is_none() && !matches!(m.sub, ModelCmdSub::Help { .. }) => {
            Action::None
        }
        KeyCode::Enter => match &m.sub {
            ModelCmdSub::RoleList => m
                .selected_uuid()
                .and_then(|token| crate::app::runtime::commands::model_cmd::parse_role(&token))
                .map(|role| Action::ModelOpenRolePick { role })
                .unwrap_or(Action::None),
            ModelCmdSub::Help { .. } => Action::ModelCancel,
            ModelCmdSub::RolePick { role } => {
                let uuid = m.selected_uuid();
                Action::ModelRoleSwap {
                    role: *role,
                    model_uuid: uuid,
                }
            }
            ModelCmdSub::AgentList => {
                // Enter on agent list → open AgentPick for that agent
                if let Some((Some(name), _)) = m.selected() {
                    Action::ModelOpenAgentPick {
                        agent_name: name.clone(),
                    }
                } else {
                    Action::None
                }
            }
            ModelCmdSub::AgentPick { agent_name, .. } => {
                let uuid = m.selected_uuid();
                Action::ModelAgentSwap {
                    agent_name: agent_name.clone(),
                    model_uuid: uuid,
                }
            }
        },
        _ => Action::None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::app_config::ModelRole;
    #[test]
    fn filtered_enter_uses_the_matching_model_and_empty_results_do_nothing() {
        let mut m = ModelCmdState {
            sub: ModelCmdSub::RolePick {
                role: ModelRole::Planner,
            },
            query: String::new(),
            from_roles: false,
            options: vec![
                (None, "inherit".into()),
                (Some("chosen".into()), "Unique model".into()),
            ],
            cursor: 0,
            note: String::new(),
        };
        let mut rest = crate::app::state::AppStateRest::default();
        m.set_query("unique".into());
        assert!(
            matches!(handle_model_cmd(&mut m,&mut rest,KeyEvent::new(KeyCode::Enter,KeyModifiers::NONE)),Action::ModelRoleSwap {role:ModelRole::Planner, model_uuid:Some(id)} if id=="chosen")
        );
        m.set_query("absent".into());
        assert!(matches!(
            handle_model_cmd(
                &mut m,
                &mut rest,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
            ),
            Action::None
        ));
        m.from_roles = true;
        assert!(matches!(
            handle_model_cmd(
                &mut m,
                &mut rest,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
            ),
            Action::ModelBackToRoles
        ));
        m.from_roles = false;
        assert!(matches!(
            handle_model_cmd(
                &mut m,
                &mut rest,
                KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)
            ),
            Action::ModelCancel
        ));
    }
    #[test]
    fn roles_are_enterable_and_typing_search_keeps_unicode() {
        let mut m = ModelCmdState {
            sub: ModelCmdSub::RoleList,
            query: String::new(),
            from_roles: false,
            options: vec![(Some("awareness".into()), "awareness".into())],
            cursor: 0,
            note: String::new(),
        };
        let mut rest = crate::app::state::AppStateRest::default();
        assert!(matches!(
            handle_model_cmd(
                &mut m,
                &mut rest,
                KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)
            ),
            Action::ModelOpenRolePick {
                role: ModelRole::Awareness
            }
        ));
        m.sub = ModelCmdSub::RolePick {
            role: ModelRole::Awareness,
        };
        for c in "猫😀".chars() {
            handle_model_cmd(
                &mut m,
                &mut rest,
                KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE),
            );
        }
        handle_model_cmd(
            &mut m,
            &mut rest,
            KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE),
        );
        assert_eq!(m.query, "猫");
    }
}
