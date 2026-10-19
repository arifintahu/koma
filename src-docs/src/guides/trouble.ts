import type { GuideStep } from '../guide'
import { chatSelect, help, quit2, tooNarrow } from '../captured'

export const helpSteps: GuideStep[] = [
  {
    title: 'The list inside koma',
    narration: 'Type /help. This is the list of commands and keys, in the terminal, without leaving the conversation.',
    frame: help,
  },
]

export const copySteps: GuideStep[] = [
  {
    title: 'Copy the conversation',
    narration: 'You can already select text in the window. Type /select when you want koma to print the whole conversation so the terminal’s own copy can take it.',
    frame: chatSelect,
  },
]

export const narrowSteps: GuideStep[] = [
  {
    title: 'Make the window wider',
    narration: 'If the window is under 50 columns, koma hides the chat and asks you to resize. q, Esc, or Ctrl+C leaves. Widen the window and the chat comes back.',
    frame: tooNarrow,
  },
]

export const quitSteps: GuideStep[] = [
  {
    title: 'Quit, detach, or cancel',
    narration: 'Type /quit, or press Ctrl+C. Pick Quit to stop the work, Detach to keep it running, or Cancel to go back to the chat.',
    frame: quit2,
  },
]
