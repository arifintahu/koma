import { modeParts, rec, str } from "./read.ts"

/** Client-owned leave guard. Live status/cursor changes cannot dirty a form. */
export class FormGuard {
  private identity = ""
  private initial = ""
  observe(mode: unknown): void {
    const form = formOf(mode)
    if (!form) { this.identity = ""; this.initial = ""; return }
    if (form.identity !== this.identity) { this.identity = form.identity; this.initial = form.content }
  }
  dirty(mode: unknown): boolean {
    const form = formOf(mode)
    return !!form && form.identity === this.identity && form.content !== this.initial
  }
  canLeave(mode: unknown): boolean {
    const parts = modeParts(mode)
    return !!parts && !parts.body.editing && !parts.body.editing_field && !parts.body.tool_picker && !parts.body.model_picker && !parts.body.editor_clear_confirm && !(parts.name === "Agents" && parts.body.editor)
  }
}
function formOf(mode: unknown): { identity: string; content: string } | null {
  const parts = modeParts(mode)
  if (!parts) return null
  const { name, body } = parts
  if ((name === "Agents" || name === "Mcp") && ["edit", "create"].includes(str(body.mode))) {
    const fields = Object.entries(body).filter(([key]) => key.startsWith("draft_") || key === "create_scope")
    return { identity: `${name}:${body.mode}:${name === "Mcp" ? body.draft_uuid : body.list_sel}`, content: JSON.stringify(fields) }
  }
  if (name === "Remote" && String(body.sub).endsWith(":edit")) {
    const e = rec(body.editor)
    return { identity: `Remote:${e.edit_id ?? "new"}`, content: JSON.stringify([e.name, e.user, e.host, e.port, e.key_path]) }
  }
  return null
}
