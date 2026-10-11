//! On-screen multi-tab browser (GUI wry surface). Separate from headless `browser_*`.
#[cfg(any(feature = "gui", test))]
pub(crate) mod act;
pub(crate) mod bridge;
pub(crate) mod contract;
pub(crate) mod controller;

pub(crate) use contract::*;
pub(crate) use controller::Controller;
