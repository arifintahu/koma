import type { GuideStep } from '../guide'
import { agents, chatTask, extensionUse, extensions, mcp, paletteNewRemote, remote, security, skill, store } from '../captured'

export const skillSteps: GuideStep[] = [
  {
    title: 'A saved way of working',
    narration: 'A skill is a set of instructions you can turn on, such as how your team writes a brief. Type /skill to load one or unload one.',
    frame: skill,
  },
]

export const assistantSteps: GuideStep[] = [
  {
    title: 'Extra assistants',
    narration: 'An assistant is a named helper with its own instructions. Type /agents to create one, change one, or remove one.',
    frame: agents,
  },
  {
    title: 'Hand one a job',
    narration: 'Type /task, the assistant, and the job. With no extra words, /task opens the list of helpers that are working now.',
    frame: chatTask,
  },
]

export const addonSteps: GuideStep[] = [
  {
    title: 'What is installed',
    narration: 'Type /extension to see add-ons installed on this computer. Enter opens one. You can remove it from there.',
    frame: extensions,
  },
  {
    title: 'Turn one on here',
    narration: 'An installed add-on is not automatically part of this conversation. Type /extension use and pick the one this conversation should use.',
    frame: extensionUse,
  },
]

export const storeSteps: GuideStep[] = [
  {
    title: 'Browse the store',
    narration: 'Type /store to browse add-ons from koma.run. Enter opens one. Install asks you to confirm before it downloads.',
    frame: store,
  },
]

export const serviceSteps: GuideStep[] = [
  {
    title: 'Another service',
    narration: 'MCP is how koma plugs in a service that already speaks that standard, such as a company tool your IT team hosts. Type /mcp to add one, edit one, or remove one.',
    frame: mcp,
  },
]

export const remoteSteps: GuideStep[] = [
  {
    title: 'A computer you can reach',
    narration: 'Type /remote to save another computer, usually one you reach with SSH. This is the address book. It does not by itself move the conversation.',
    frame: remote,
  },
  {
    title: 'Start there',
    narration: 'Type /new remote to start a new conversation on one of those computers. Type /resume remote to open a conversation that is already there.',
    frame: paletteNewRemote,
  },
]

export const safetySteps: GuideStep[] = [
  {
    title: 'Safety checks',
    narration: 'Type /security to open the safety panel. You can turn the checks on, turn individual tools off, and turn Yooloo on or off. Yooloo only works while this panel is running.',
    points: ['This panel is not available on Windows.', 'Turning Yooloo off returns the conversation to Auto.'],
    frame: security,
  },
]
