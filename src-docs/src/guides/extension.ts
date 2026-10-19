import type { GuideStep } from '../guide'
import { extensionUse, extensions, store } from '../captured'

export const installedSteps: GuideStep[] = [
  {
    title: 'What is installed',
    narration: 'Type /extension. This is every add-on on this computer. A row here is not yet available in the conversation you are in.',
    frame: extensions,
  },
]

export const useSteps: GuideStep[] = [
  {
    title: 'Turn one on here',
    narration: 'Type /extension use. Enter on a row turns that add-on on for this conversation only. Esc returns you to the chat.',
    frame: extensionUse,
  },
]

export const storeSteps: GuideStep[] = [
  {
    title: 'Browse the store',
    narration: 'Type /store when you want one Koma already publishes. Enter opens it. Install asks you to confirm before anything is downloaded.',
    frame: store,
  },
]
