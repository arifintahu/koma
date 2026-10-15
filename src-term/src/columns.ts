import { useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"

/** The narrower of the renderer and the real tty. A resize with no width must not stick. */
export function useColumns(): number {
  const renderer = useRenderer()
  const [width, setWidth] = useState(() => columnsNow(renderer.width))
  useEffect(() => {
    const read = () => {
      const next = columnsNow(renderer.width)
      setWidth((current) => (current === next ? current : next))
    }
    renderer.on("resize", read)
    const timer = setInterval(read, 200)
    return () => {
      renderer.off("resize", read)
      clearInterval(timer)
    }
  }, [renderer])
  return width
}

export function columnsNow(rendererWidth: number): number {
  const reported = process.stdout.columns
  const values = [rendererWidth, reported].filter((value): value is number => typeof value === "number" && value > 0)
  if (values.length === 0) return 80
  return Math.min(...values)
}
