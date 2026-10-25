import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, expect, test } from "bun:test"
import { act, useMemo, useState } from "react"
import { useRenderer } from "@opentui/react"
import { CodeRenderable, SyntaxStyle, rgbToHex, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import { MarkdownBody } from "./chat.tsx"
import { syntaxClient, syntaxStyles } from "./syntax.ts"
import { PALETTE_NAMES, themeFor } from "./theme.ts"
import { writeFileSync } from "node:fs"
const frames: string[] = []
function Body({content, palette="dark", streaming=false}: {content:string;palette?:string;streaming?:boolean}) {
  const renderer=useRenderer(), theme=themeFor(palette)
  const style=useMemo(()=>SyntaxStyle.fromStyles(syntaxStyles(theme),renderer.nativeScene),[renderer,palette])
  return <box flexDirection="column" backgroundColor={theme.bg}><MarkdownBody content={content} fg={theme.fg} syntaxStyle={style} streaming={streaming}/></box>
}
const examples = {
  python: 'def hello(name):\n    # Unicode 猫\n    return "`hello`" + name + str(42)',
  rust: 'fn main() {\n    // Unicode 猫\n    let value = "`hello`";\n    println!("{}", 42);\n}',
  javascript: 'function hello(name) {\n    // Unicode 猫\n    return "`hello`" + name + 42;\n}',
  typescript: 'function hello(name: string): string {\n    // Unicode 猫\n    return "`hello`" + name + 42;\n}',
}
test("bundled parsers and aliases highlight offline",async()=>{
  const original=globalThis.fetch
  globalThis.fetch=(()=>{throw Error("network unavailable")}) as unknown as typeof fetch
  try {
    await syntaxClient.initialize()
    for(const [language,content] of Object.entries(examples)) {
      for(const alias of [language, ...({python:["py","python3"],rust:["rs"],javascript:["js"],typescript:["ts"]}[language]??[])]) {
        const result=await syntaxClient.highlightOnce(content,alias)
        expect(result.error).toBeUndefined()
        expect(result.highlights?.some(h=>h[2].startsWith("keyword"))).toBe(true)
      }
    }
  } finally {globalThis.fetch=original}
})
for (const [width,height] of [[50,24],[80,18],[100,40],[160,45]]) {
  for (const palette of PALETTE_NAMES) test(`native syntax spans and square code borders / ${palette} / ${width}×${height}`,async()=>{
    for (const [language, code] of Object.entries(examples)) {
    const content='```'+language+'\n'+code+'\n```'
    const view=await testRender(<Body content={content} palette={palette}/>,{width,height})
    try {
      await act(async()=>{await view.waitForVisualIdle()})
      await act(async()=>{
        const wait = async (node: Renderable): Promise<void> => {
          if (node instanceof CodeRenderable) await node.highlightingDone
          await Promise.all(node.getChildren().map(wait))
        }
        await wait(view.renderer.root)
        await view.waitForVisualIdle()
      })
      const frame=view.captureCharFrame()
      frames.push(`${palette} ${language} ${width}×${height}\n${frame}`)
      expect(frame).toContain("┌"); expect(frame).toContain("└"); expect(frame).toContain("┘")
      expect(frame).toContain(language); expect(frame).toContain("`hello`")
      const word=language === "python" ? "def" : language === "rust" ? "fn" : "function"
      const keyword=view.captureSpans().lines.flatMap(l=>l.spans).find(s=>s.text.includes(word))
      const label=view.captureSpans().lines.flatMap(l=>l.spans).find(s=>s.text.includes(language))!
      expect(rgbToHex(label.fg)).toBe(themeFor(palette).fg)
      expect(keyword).toBeDefined()
      expect(rgbToHex(keyword!.fg)).toBe(themeFor(palette).accent)
    } finally {await act(async()=>{await view.dispose()})}
    }
  })
}
test("code tokens preserve indentation, empty/unknown blocks, long Unicode lines and streaming fences",async()=>{
  const content='    indented `literal`\n      more 猫\n\n```unknown\n'+ '猫'.repeat(120)+'\n```\n\n```\n```\n\n```python\ndef hello():\n    return "``` literal"'
  let complete = () => {}
  function Streaming() {
    const [done,setDone] = useState(false)
    complete=()=>setDone(true)
    return <Body content={content+(done ? "\n```" : "")} streaming={!done}/>
  }
  const view=await testRender(<Streaming/>,{width:50,height:40})
  try {
    await act(async()=>{await view.waitForVisualIdle()})
    const before=view.captureCharFrame()
    expect(before).toContain("indented `literal`")
    expect(before).toContain('return "``` literal"')
    await act(async()=>{complete();view.resize(80,40);await view.waitForVisualIdle()})
    await act(async()=>{await view.waitForVisualIdle()})
    const after=view.captureCharFrame(); frames.push(`edge cases 80×40\n${after}`)
    expect(after).toContain("unknown")
    expect(after).toContain('return "``` literal"'); expect(after).toContain("┘")
    const contents:string[]=[]
    const collect=(node:Renderable)=>{if(node instanceof CodeRenderable) contents.push(node.content);node.getChildren().forEach(collect)}
    collect(view.renderer.root)
    expect(contents).toContain('indented `literal`\n  more 猫')
    expect(contents).toContain('猫'.repeat(120))
    expect(contents).toContain("")
    expect(contents).toContain('def hello():\n    return "``` literal"')
  } finally {await act(async()=>{await view.dispose()})}
})
afterAll(()=>{writeFileSync(process.env.KOMA_CODE_PREVIEW_PATH??join(tmpdir(), "koma-code-frames.txt"),frames.join("\n\n"))})
