import Lottie from 'lottie-react'
import animations from 'virtual:lottie-animations'

// Two states only:
//   working → black cat
//   idle    → rolling loader cat
const ROLLING = 'Loader cat'
const IDLE = 'black rainbow cat'

export default function CatMascotLottie({ working }: { working: boolean }) {
  const key = working ? IDLE : ROLLING
  const data = animations[key] ?? animations[IDLE] ?? Object.values(animations)[0]
  if (!data) throw new Error('no lottie animations bundled')
  return <Lottie key={key} animationData={data} loop autoplay className="h-full w-full" />
}
