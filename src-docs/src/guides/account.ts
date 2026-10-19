import type { GuideStep } from '../guide'
import { notifications, settingsAppearance, settingsGeneral, settingsModels, settingsOauth, settingsProviders, settingsQuick, usage } from '../captured'

export const settingsSteps: GuideStep[] = [
  {
    title: 'Open settings',
    narration: 'Type /settings. You can also type /config. The first page is the look and the everyday switches.',
    frame: settingsQuick,
  },
  {
    title: 'The other pages',
    narration: 'Press 2 for providers, 3 for sign-in connections, and 4 for models. Esc leaves settings and returns to the chat.',
    frame: settingsProviders,
  },
]

export const themeSteps: GuideStep[] = [
  {
    title: 'Pick a theme',
    narration: 'Appearance lists the themes. Enter applies the one you are on. The terminal changes immediately.',
    points: ['dark, light, forest, autumn, warm, cold symphony, winter, monokai, vscode, and github dark.'],
    frame: settingsAppearance,
  },
]

export const generalSteps: GuideStep[] = [
  {
    title: 'Everyday switches',
    narration: 'General is the list of switches for this conversation and this computer. Enter opens the one you are on.',
    frame: settingsGeneral,
  },
]

export const providerSteps: GuideStep[] = [
  {
    title: 'Who answers',
    narration: 'Providers are the accounts and endpoints koma can use. Enter edits one. Ctrl+X deletes one, after you confirm.',
    frame: settingsProviders,
  },
]

export const oauthSteps: GuideStep[] = [
  {
    title: 'Sign-in connections',
    narration: 'OAuth is the sign-in list. Enter connects, or reconnects, the account you are on. You finish in the browser, then come back.',
    frame: settingsOauth,
  },
]

export const modelsPageSteps: GuideStep[] = [
  {
    title: 'Which model does which job',
    narration: 'Models shows the model assigned to each job. Enter changes the row you are on.',
    frame: settingsModels,
  },
]

export const noticeSteps: GuideStep[] = [
  {
    title: 'After the toast fades',
    narration: 'A short notice appears and then disappears. Type /notification to search the ones koma saved.',
    frame: notifications,
  },
]

export const costSteps: GuideStep[] = [
  {
    title: 'What this conversation spent',
    narration: 'Type /usage. You see the tokens and the cost for this conversation, so you can tell an expensive request from a cheap one.',
    frame: usage,
  },
]
