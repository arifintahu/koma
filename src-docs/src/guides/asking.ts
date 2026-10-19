import type { GuideStep } from '../guide'
import { bash, bashBg, chatClear, chatCompact, chatFile, chatMultiline, chatReply, chatWorking, rewind, settingsGeneral, settingsInternetFull, todo } from '../captured'

export const writeSteps: GuideStep[] = [
  {
    title: 'One line',
    narration: 'Type the request and press Enter. Say what done looks like, not the internal steps.',
    frame: chatMultiline,
  },
  {
    title: 'More than one line',
    narration: 'Shift+Enter or Ctrl+J starts a new line without sending. Enter still sends the whole note.',
    frame: chatMultiline,
  },
]

export const againSteps: GuideStep[] = [
  {
    title: 'Send it again',
    narration: 'Ctrl+R sends the last request again. Use it when the answer missed the point and you want another try.',
    frame: chatReply,
  },
]

export const rewindSteps: GuideStep[] = [
  {
    title: 'Pick an earlier message',
    narration: 'Press Esc twice. Koma lists what you sent. Choose the one you want to change. Everything after that point is set aside so you can rewrite it.',
    frame: rewind,
  },
]

export const pictureSteps: GuideStep[] = [
  {
    title: 'Paste a picture',
    narration: 'Copy a picture, click the terminal, and press Ctrl+V. A chip appears above the box. Enter sends the picture with whatever you typed.',
    frame: chatReply,
  },
  {
    title: 'A pasted note',
    narration: 'A long paste becomes a note attached to the request, so the box does not fill up with it. Ctrl+P opens the notes and pictures waiting to send.',
    points: ['Alt+E edits the nearest attached note.'],
    frame: chatReply,
  },
]

export const fileSteps: GuideStep[] = [
  {
    title: 'Type @',
    narration: 'Type @ and the start of a file name. Koma lists files in the folder. Tab or Enter puts that file into your request.',
    frame: chatFile,
  },
]

export const workingSteps: GuideStep[] = [
  {
    title: 'It tells you what it is doing',
    narration: 'While koma works, you see a short status under the box, and sometimes a note of what it is reading. The answer, when it arrives, stays in the conversation.',
    frame: chatWorking,
  },
  {
    title: 'The answer stays',
    narration: 'When it finishes, the answer stays in the conversation. Scroll with the arrow keys or the mouse wheel.',
    frame: chatReply,
  },
]

export const todoSteps: GuideStep[] = [
  {
    title: 'The list for this conversation',
    narration: 'Type /todo to see the list koma is keeping for this piece of work. It is a checklist, not a second conversation.',
    frame: todo,
  },
]

export const bashSteps: GuideStep[] = [
  {
    title: 'Commands koma runs',
    narration: 'When koma needs to run a command on your computer, it shows up here. Type /bash to see what is running and what already finished.',
    frame: bash,
  },
  {
    title: 'Let a long one keep going',
    narration: 'Ctrl+B sends a command that is blocking you into the background. Koma tells you when it finishes. Ctrl+X stops the one you have selected.',
    frame: bashBg,
  },
]

export const internetSteps: GuideStep[] = [
  {
    title: 'Simple lookup',
    narration: 'Simple is the usual setting. Koma can search and open pages without driving a full browser. Ctrl+E switches between simple and full.',
    frame: settingsGeneral,
  },
  {
    title: 'Full browsing',
    narration: 'Full is for pages that need a real browser. It uses more of the model, and it is not available on Windows.',
    frame: settingsInternetFull,
  },
]

export const longSteps: GuideStep[] = [
  {
    title: 'Shorten it',
    narration: 'Type /compact when the conversation is long and you want koma to summarize it and keep going. The summary replaces the older detail in what koma reads next. Your saved history is still there.',
    frame: chatCompact,
  },
  {
    title: 'Clear the screen',
    narration: 'Type /clear when you want a clean chat. The archive of what was said is kept. This is not the same as deleting the conversation.',
    frame: chatClear,
  },
]
