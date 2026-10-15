import { useRenderer } from "@opentui/react"
import { useEffect, useState } from "react"
import { addDirArgument, FOLDER_GUIDE_ROWS, guideFolders } from "./dirs.ts"
import type { Theme } from "./theme.ts"

/** Folders inside the `/adddir` path. Not a picker: nothing is highlighted or chosen. */
export function FolderGuide({ draft, cwd, theme }: { draft: string; cwd: string; theme: Theme }) {
  const width = useRenderer().width
  const arg = addDirArgument(draft)
  const [shown, setShown] = useState<string | null>(null)
  const [rows, setRows] = useState<string[] | null>(null)
  useEffect(() => {
    if (!arg) return
    let dead = false
    const timer = setTimeout(() => {
      void guideFolders(arg, cwd).then((names) => {
        if (dead) return
        setShown(arg)
        setRows(names)
      })
    }, 40)
    return () => { dead = true; clearTimeout(timer) }
  }, [arg, cwd])
  if (!arg || shown !== arg || !rows) return null
  const room = Math.max(8, width - 6)
  const visible = rows.slice(0, FOLDER_GUIDE_ROWS)
  const more = rows.length - visible.length
  const title = [...arg].length > room ? `${[...arg].slice(0, room - 1).join("")}…` : arg
  return (
    <box
      border
      borderStyle="rounded"
      borderColor={theme.dim}
      backgroundColor={theme.bg}
      flexDirection="column"
      flexShrink={0}
      title={` ${title} `}
      titleColor={theme.dim}
    >
      {visible.length === 0 ? <text fg={theme.dim}>no folders</text> : visible.map((name) => (
        <text key={name} fg={theme.fg}>{clip(name, room)}</text>
      ))}
      {more > 0 ? <text fg={theme.dim}>{`${more} more`}</text> : null}
    </box>
  )
}

function clip(name: string, room: number): string {
  const chars = [...name]
  if (chars.length <= room) return name
  return `${chars.slice(0, Math.max(0, room - 1)).join("")}…`
}
