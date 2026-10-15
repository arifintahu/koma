//! Additive full-screen menu protocol. Legacy key clients remain supported.
use serde::{Deserialize, Serialize};
use super::KeyWire;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MenuAction {
    /// Focus the actual list/field, optionally verifying its stable identity.
    Select { group: String, index: usize, #[serde(default)] id: Option<String> },
    /// Replace an editable draft without replaying keystrokes.
    Replace { field: String, value: String },
    /// Invoke an explicit existing control through its domain handler.
    Key(KeyWire),
    Save,
    Discard,
    KeepEditing,
}
