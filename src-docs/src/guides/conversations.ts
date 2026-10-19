import type { GuideStep } from '../guide'
import { chatAdddir, chatCd, chatRename, hubCooking, hubHistory, paletteNew, paletteNewKill, settingsGeneral } from '../captured'

export const anotherSteps: GuideStep[] = [
  {
    title: 'Type /new',
    narration: 'Type /new when this conversation should keep running and you want a fresh one beside it.',
    frame: paletteNew,
  },
  {
    title: 'Both stay in the list',
    narration: 'The new conversation opens. The old one stays under Cooking, marked ready or working.',
    frame: hubCooking,
  },
]

export const closeSteps: GuideStep[] = [
  {
    title: 'Type /new kill',
    narration: 'Type /new kill when you are finished with this conversation and want to start clean. This one closes. It does not stay working in the background.',
    frame: paletteNewKill,
  },
]

export const findSteps: GuideStep[] = [
  {
    title: 'Cooking',
    narration: 'Cooking is the work that is open now. + New session starts a blank one. Enter opens the row you are on.',
    points: ['Tab switches between Cooking and History.', 'Ctrl+X on Cooking asks before it stops a conversation.'],
    frame: hubCooking,
  },
  {
    title: 'History',
    narration: 'History is the conversations you have already closed. Search by name. Enter opens one again.',
    points: ['Ctrl+X on History asks before it deletes a saved conversation.'],
    frame: hubHistory,
  },
]

export const renameSteps: GuideStep[] = [
  {
    title: 'Give it a name',
    narration: 'Type /rename and the name you want. The name shows on the box where you type, so you can tell conversations apart.',
    frame: chatRename,
  },
]

export const folderSteps: GuideStep[] = [
  {
    title: 'The folder koma is using',
    narration: 'Each conversation has a working folder. That is the project koma reads and changes.',
    frame: settingsGeneral,
  },
  {
    title: 'Move to another folder',
    narration: 'Type /cd and the folder path when the work should happen somewhere else.',
    frame: chatCd,
  },
  {
    title: 'Add a second folder',
    narration: 'Type /adddir when koma also needs to see another folder, without leaving the first one.',
    frame: chatAdddir,
  },
]
