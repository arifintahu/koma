import type { GuideStep } from '../guide'
import { chatDraft, chatReady, chatReply, chatStopped, chatWorking, chatYou, hubCooking, opening, ownKey, ownKeyModel, quit0, quit1, signIn, warming, welcome0, welcome1, welcome2 } from '../captured'

export const welcomeSteps: GuideStep[] = [
  {
    title: 'The first question',
    narration: 'The first time koma opens, it asks how you want to connect. You only answer this once.',
    points: ['You can change it later in settings.', 'Press q if you want to leave before choosing.'],
    frame: welcome0,
  },
  {
    title: 'Start free',
    narration: 'koma free starts now. You do not need an account or a key. The models are the free ones koma hosts.',
    frame: welcome0,
  },
  {
    title: 'Sign in',
    narration: 'Connect a provider if you already have an account, such as ChatGPT or Claude. Koma sends you to that site to sign in.',
    frame: welcome1,
  },
  {
    title: 'Your own key',
    narration: 'Use an API key when your company gives you an address and a key, or when you want a model that is not in the sign-in list.',
    frame: welcome2,
  },
]

export const signInSteps: GuideStep[] = [
  {
    title: 'Pick the account',
    narration: 'Choose the account you already use. The names you see depend on what koma can sign in to.',
    frame: signIn,
  },
  {
    title: 'Sign in in the browser',
    narration: 'Koma opens your browser. Sign in there, then come back to the terminal. You do not paste the password into the terminal.',
    points: ['If the browser does not open, copy the address koma shows and open it yourself.'],
    frame: signIn,
  },
  {
    title: 'Pick a model',
    narration: 'After you are signed in, choose the model that will answer in this conversation. You can switch it later.',
    frame: ownKeyModel,
  },
]

export const ownKeySteps: GuideStep[] = [
  {
    title: 'Address and key',
    narration: 'Paste the address your provider gave you, then the key. The key is hidden as you type.',
    points: ['Tab moves to the next field.', 'Enter continues.', 'Esc cancels.'],
    frame: ownKey,
  },
  {
    title: 'Pick a model',
    narration: 'Search the list, or paste a model name if you already know it. Enter finishes setup.',
    frame: ownKeyModel,
  },
]

export const openSteps: GuideStep[] = [
  {
    title: 'Opening',
    narration: 'Koma shows its name while it opens your conversation. This usually takes a moment.',
    frame: opening,
  },
  {
    title: 'Getting ready',
    narration: 'It then looks at the folder you opened and reads the project notes it can find. Press Esc if you want to skip this and start talking.',
    frame: warming,
  },
  {
    title: 'Ready',
    narration: 'When the box at the bottom is ready, you can type. The word ready means koma is waiting for you.',
    frame: chatReady,
  },
]

export const chatSteps: GuideStep[] = [
  {
    title: 'Your words',
    narration: 'What you sent sits in the conversation.',
    frame: chatYou,
  },
  {
    title: 'Koma’s answer',
    narration: 'The answer appears under your words. A long answer stays in the conversation so you can scroll back to it.',
    frame: chatReply,
  },
  {
    title: 'Where you type',
    narration: 'The box at the bottom is where the next request goes. The name on the corner is this conversation. The line above the box shows how careful koma is, and which model is answering.',
    points: ['Normal means koma will ask before it changes something risky.', 'The model name is on the right.'],
    frame: chatReply,
  },
]

export const firstRequestSteps: GuideStep[] = [
  {
    title: 'Type in plain language',
    narration: 'You do not need a special command. Describe the outcome you want.',
    frame: chatDraft,
  },
  {
    title: 'Press Enter',
    narration: 'Enter sends it. Your request moves up into the conversation, and the bottom line shows that koma is working.',
    frame: chatWorking,
  },
  {
    title: 'Read the answer',
    narration: 'Koma answers in the same conversation. Ask a follow-up in the box. It already knows what you just said.',
    frame: chatReply,
  },
]

export const stopSteps: GuideStep[] = [
  {
    title: 'While it is working',
    narration: 'The bottom line changes from ready to a working word, with a timer. That means koma is still on your request.',
    frame: chatWorking,
  },
  {
    title: 'Press Esc',
    narration: 'Esc tells koma to stop. It keeps what is already on screen and waits for a new request.',
    frame: chatStopped,
  },
]

export const leaveSteps: GuideStep[] = [
  {
    title: 'You are asked before you leave',
    narration: 'Ctrl+C or /quit asks what you want. Leaving the screen does not delete the conversation.',
    frame: quit1,
  },
  {
    title: 'Keep it running',
    narration: 'Detach closes the terminal and leaves the conversation working. Choose this when koma is in the middle of something and you need to close the laptop.',
    frame: quit1,
  },
  {
    title: 'Stop it',
    narration: 'Quit stops the work in this conversation. Choose this when you are done and you do not want it to keep going.',
    frame: quit0,
  },
  {
    title: 'Come back',
    narration: 'Open koma again and look under Cooking. A conversation you detached is still there.',
    points: ['Type /resume from a conversation to open this list.', 'Or start koma with the agents list if you do not want a new conversation yet.'],
    frame: hubCooking,
  },
]
