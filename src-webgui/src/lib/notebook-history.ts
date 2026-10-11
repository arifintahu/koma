/** Structural + source undo stack for a notebook controller (document text authority). */

export type NotebookHistoryEntry = {
  text: string
  label: string
}

const DEFAULT_LIMIT = 100

export class NotebookHistory {
  private undoStack: NotebookHistoryEntry[] = []
  private redoStack: NotebookHistoryEntry[] = []
  constructor(private readonly limit = DEFAULT_LIMIT) {}

  get canUndo() { return this.undoStack.length > 0 }
  get canRedo() { return this.redoStack.length > 0 }

  /** Record the document text *before* applying an edit. */
  pushBefore(text: string, label: string) {
    this.undoStack.push({ text, label })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    this.redoStack = []
  }

  undo(currentText: string): NotebookHistoryEntry | null {
    const entry = this.undoStack.pop()
    if (!entry) return null
    this.redoStack.push({ text: currentText, label: entry.label })
    return entry
  }

  redo(currentText: string): NotebookHistoryEntry | null {
    const entry = this.redoStack.pop()
    if (!entry) return null
    this.undoStack.push({ text: currentText, label: entry.label })
    return entry
  }

  /** Drop the most recent undo entry without applying it (failed CAS). */
  dropLast() {
    this.undoStack.pop()
    // redo stays cleared from pushBefore
  }

  clear() {
    this.undoStack = []
    this.redoStack = []
  }
}
