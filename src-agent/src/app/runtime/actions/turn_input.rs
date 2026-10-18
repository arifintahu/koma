//! Request-owned input preparation. Never reads or changes the composer or allocates turn IDs.
use crate::app::state::AppState;
use crate::dto::chat::Attachment;
use crate::ipc::proto::TurnAttachmentInput;
use crate::model::attachment;
use anyhow::{ensure, Result};
use std::io::Read;
use std::path::Path;

pub(crate) struct PreparedTurnInput {
    pub text: String,
    pub attachments: Vec<Attachment>,
}

pub(crate) fn prepare(
    state: &AppState,
    text: String,
    inputs: Vec<TurnAttachmentInput>,
) -> Result<PreparedTurnInput> {
    prepare_with_limit(state, text, inputs, 32 * 1024 * 1024)
}

pub(crate) fn prepare_with_limit(
    state: &AppState,
    mut text: String,
    inputs: Vec<TurnAttachmentInput>,
    limit: usize,
) -> Result<PreparedTurnInput> {
    ensure!(!text.trim().is_empty(), "empty prompt");
    ensure!(inputs.len() <= 16, "at most 16 attachments allowed");
    let sess = state
        .rest
        .fg()
        .session
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("no active session"))?;
    if inputs
        .iter()
        .any(|i| matches!(i, TurnAttachmentInput::ImageFile { .. }))
    {
        ensure!(
            super::chat::model_accepts_images(state),
            "model does not support image input"
        );
    }
    // Read and validate the entire batch before the first ingest. Bounded reads protect
    // against growing files as well as misleading metadata. No cleanup of ingest orphans.
    let mut total = 0usize;
    let mut batch = Vec::new();
    for input in inputs {
        match input {
            TurnAttachmentInput::ImageFile { path } => {
                let path = Path::new(&path);
                ensure!(path.is_absolute(), "image path must be absolute");
                let file = std::fs::File::open(path)?;
                ensure!(file.metadata()?.is_file(), "image must be a regular file");
                let mut bytes = Vec::new();
                file.take((limit.saturating_sub(total) + 1) as u64)
                    .read_to_end(&mut bytes)?;
                total += bytes.len();
                ensure!(total <= limit, "attachment byte limit exceeded");
                ensure!(
                    attachment::sniff_image_mime(path, &bytes).is_some(),
                    "not a recognised image"
                );
                let name = path
                    .file_name()
                    .ok_or_else(|| anyhow::anyhow!("image path has no file name"))?
                    .to_string_lossy()
                    .into_owned();
                batch.push((Some(name), bytes, None));
            }
            TurnAttachmentInput::PastedText { text, name } => {
                ensure!(
                    text.len() <= attachment::PASTE_SOFT_MAX_BYTES,
                    "paste exceeds 2 MiB"
                );
                total += text.len();
                ensure!(total <= limit, "attachment byte limit exceeded");
                batch.push((None, text.into_bytes(), name));
            }
        }
    }
    let mut attachments = Vec::new();
    for (image_name, bytes, label) in batch {
        let (mut item, marker) = if let Some(name) = image_name {
            attachment::ingest_image_bytes(&sess.path.join("images"), &name, &bytes)?
        } else {
            attachment::ingest_paste_text(&sess.path.join("pastes"), std::str::from_utf8(&bytes)?)?
        };
        item.label = label.as_deref().and_then(attachment::sanitize_paste_label);
        text.push('\n');
        text.push_str(&marker);
        attachments.push(item);
    }
    Ok(PreparedTurnInput { text, attachments })
}
