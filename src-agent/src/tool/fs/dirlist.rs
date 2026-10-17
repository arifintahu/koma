//! `dir_list` tool — list directory contents directly from the filesystem.

use crate::tool::{resolve, Tool, ToolCtx};
use anyhow::Result;
use serde_json::{json, Value};

/// List directory contents directly from the filesystem (one level deep, multi-path).
pub struct DirList;

impl Tool for DirList {
    fn name(&self) -> &'static str {
        "dir_list"
    }
    fn description(&self) -> &'static str {
        "List the contents of one or more workspace directories directly from the filesystem (folders end with '/'). Pass `paths` (an array) to list several directories in one call — prefer this over many separate calls."
    }
    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "paths": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "Workspace-relative directory paths to list. Use [\".\"] for the workspace root. A bare relative path targets workspace [0]."
                },
                "path": { "type": "string", "description": "A single directory (alternative to `paths`)." }
            }
        })
    }
    fn run(&self, ctx: &ToolCtx, args: &Value) -> Result<String> {
        // Accept `paths` (array) or a single `path`; default to the workspace root.
        let mut dirs: Vec<String> = Vec::new();
        if let Some(arr) = args.get("paths").and_then(Value::as_array) {
            for v in arr {
                if let Some(s) = v.as_str() {
                    dirs.push(s.to_string());
                }
            }
        }
        if let Some(s) = args.get("path").and_then(Value::as_str) {
            dirs.push(s.to_string());
        }
        if dirs.is_empty() {
            dirs.push(".".to_string());
        }

        const MAX_ENTRIES: usize = 500;

        let mut out = String::new();
        let mut total_entries = 0usize;
        for dir in &dirs {
            let resolved = resolve(&ctx.workspaces, dir)?;
            let label = crate::tool::model_display_path(&ctx.workspaces, &resolved);
            let label = if label.is_empty() { "." } else { &label };
            let remaining = MAX_ENTRIES - total_entries;
            let mut listed = 0;
            let mut truncated = false;
            let result = crate::tool::recovery::inspect(
                ctx,
                self.name(),
                &json!({"path": dir}),
                dir,
                &resolved,
                || {
                    let (children, capped, excluded) =
                        crate::tool::recovery::visible_entries(&resolved, remaining)?;
                    listed = children.len();
                    truncated = capped;
                    let mut listing = String::new();
                    if children.is_empty() && !capped {
                        listing.push_str(if excluded {
                            "  (entries excluded by visibility rules)\n"
                        } else {
                            "  (empty directory)\n"
                        });
                    }
                    for child in children {
                        listing.push_str(&format!("  {child}\n"));
                    }
                    if capped {
                        listing
                            .push_str("... (truncated at 500 entries; use a more specific path)\n");
                    }
                    Ok(listing)
                },
            )?;
            out.push_str(&format!("{label}:\n"));
            total_entries += listed;
            out.push_str(&result);
            if truncated {
                break;
            }
            out.push('\n');
        }
        Ok(out.trim_end().to_string())
    }
}
