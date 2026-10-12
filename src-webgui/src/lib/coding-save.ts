import { getCodingConfig, editorPreferences } from './coding-config'
import { queryCodingLanguage } from './coding-language'
import { applyWorkspaceTextEdits, type TextEdit } from './workspace-edit-text'
import type { WorkspaceRef } from './coding-service'
import { isNotebookPath } from './notebook-workspace'

// All save entry points (including Save All and autosave) share this pipeline.
export async function formatBeforeSave(workspace: WorkspaceRef, path: string, content: string): Promise<string> {
  // A broken configuration must remain fixable from its own editor.
  // Notebook JSON must never be format-on-save rewritten.
  if (path === '.koma/coding.json' || isNotebookPath(path)) return content
  const config = await getCodingConfig(workspace)
  const { languageIdForPath, flushPendingLspDidChange } = await import('./monaco-lsp')
  const settings = editorPreferences(config, languageIdForPath(path))
  if (settings.formatOnSave !== true) return content
  await flushPendingLspDidChange(workspace.root, path)
  const edits = await queryCodingLanguage<TextEdit[] | null>(workspace, path, 'textDocument/formatting', {
    options: { tabSize: typeof settings.tabSize === 'number' ? settings.tabSize : 4, insertSpaces: settings.insertSpaces !== false },
  })
  return applyWorkspaceTextEdits(content, edits ?? [])
}
