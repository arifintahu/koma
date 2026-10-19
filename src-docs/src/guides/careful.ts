import type { GuideStep } from '../guide'
import { chatFree, chatModeAuto, chatModeNormal, chatModePlan, chatModeSdlc, chatModeYolo, effort, model } from '../captured'

export const waysSteps: GuideStep[] = [
  {
    title: 'Auto',
    narration: 'Auto means koma goes ahead. It does not stop to ask before it reads, edits, or runs a command.',
    frame: chatModeAuto,
  },
  {
    title: 'Normal',
    narration: 'Normal means koma still reads on its own, and it stops to ask before it writes, deletes, or does something else risky.',
    frame: chatModeNormal,
  },
  {
    title: 'Planning',
    narration: 'Planning means koma only looks and writes a plan. It does not change files or run commands until you approve that plan.',
    frame: chatModePlan,
  },
  {
    title: 'SDLC',
    narration: 'SDLC is for a larger delivery. Koma agrees the goal, what done looks like, and the steps with you first. After you approve, it does the work on its own branch.',
    frame: chatModeSdlc,
  },
  {
    title: 'Yooloo',
    narration: 'Yooloo means koma acts without asking, and without the extra safety check. It can still only change files inside the project. You turn this on from Safety checks, so it does not happen by accident. The screen spells it Yooloo.',
    frame: chatModeYolo,
  },
]

export const changeModeSteps: GuideStep[] = [
  {
    title: 'Cycle the everyday choices',
    narration: 'Shift+Tab moves through Auto, Normal, Planning, and SDLC. The word on the line above the box changes as you go. Yooloo is not on this cycle.',
    frame: chatModePlan,
  },
  {
    title: 'Or type it',
    narration: 'Type /mode to move to the next choice, or /mode normal to pick one. /mode yolo works only after you have turned Yooloo on in Safety checks.',
    frame: chatModeNormal,
  },
]

export const effortSteps: GuideStep[] = [
  {
    title: 'How hard it thinks',
    narration: 'Type /effort and choose a level. A higher level spends more time, and usually more money, on the answer. The level shows next to the model name when it is not the usual one.',
    frame: effort,
  },
]

export const freeSteps: GuideStep[] = [
  {
    title: 'Switch this conversation',
    narration: 'Type /free to use the free connection for this conversation only. Type /free again to go back to the model you configured.',
    frame: chatFree,
  },
]

export const modelSteps: GuideStep[] = [
  {
    title: 'Five jobs',
    narration: 'The model you talk to is main. The others are helpers: one that reads the project, one that checks safety, one that shortens a long conversation, and one that plans.',
    frame: model,
  },
  {
    title: 'Change one job',
    narration: 'Type /model, pick the job, then pick the model. Type /model help inside koma if you want the short list of jobs again.',
    frame: model,
  },
]
