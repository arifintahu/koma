import { spawn } from "node:child_process"

/** Copy selected transcript text. OSC 52 first, then the system clipboard. */
export function copyText(text: string): void {
  if (!text) return
  const payload = Buffer.from(text, "utf8").toString("base64")
  try {
    process.stdout.write(`\x1b]52;c;${payload}\x07`)
  } catch {
    // The renderer owns the tty. The system clipboard below still runs.
  }
  if (process.platform === "darwin") {
    writeTo("pbcopy", [], text)
    return
  }
  if (process.platform === "win32") {
    writeTo("clip", [], text)
    return
  }
  writeTo("sh", ["-c", "wl-copy || xclip -selection clipboard || xsel --clipboard --input"], text)
}

function writeTo(command: string, args: string[], text: string): void {
  try {
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => {})
    child.stdin.write(text)
    child.stdin.end()
  } catch {
    // No clipboard helper on this machine.
  }
}
