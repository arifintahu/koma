export type GuideFrame = {
  cols: number
  rows: number
  ansi: string
}

export type GuideStep = {
  title: string
  narration: string
  points?: string[]
  frame: GuideFrame
}
