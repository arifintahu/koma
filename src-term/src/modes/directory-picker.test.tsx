import { expect, test } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { ModeSurface } from "./surface.tsx"
import { nativeMenuInput } from "./bits.tsx"
import { themeFor } from "../theme.ts"

const theme = themeFor("monokai")

function picker(query: string) {
  return {
    Settings: {
      page: "quick",
      picker: { query, matches: [`${query}next`], sel: 0 },
    },
  }
}

test("tab enter writes the directory into the search bar, including a second level", async () => {
  const requests: unknown[] = []
  let setQuery = (_query: string) => {}
  function Harness() {
    const [query, update] = useState("/Use")
    setQuery = update
    return <ModeSurface mode={picker(query)} theme={theme} columns={80} onMove={() => {}} send={(request) => requests.push(request)} />
  }
  const view = await testRender(<Harness />, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe("/Use")
    const entered = "/Users/agungnd/Applications/"
    await act(async () => { setQuery(entered); await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe(entered)
    expect(nativeMenuInput.current?.cursorOffset).toBe(entered.length)
    const deeper = "/Users/agungnd/Applications/Utilities/"
    await act(async () => { setQuery(deeper); await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe(deeper)
    expect(nativeMenuInput.current?.cursorOffset).toBe(deeper.length)
    expect(requests.filter((request) => JSON.stringify(request).includes(entered))).toHaveLength(0)
  } finally {
    await act(async () => { await view.dispose() })
  }
})

test("tilde and dot paths fill the search bar without clobbering newer typing", async () => {
  const requests: unknown[] = []
  let setQuery = (_query: string) => {}
  function Harness() {
    const [query, update] = useState("~/")
    setQuery = update
    return <ModeSurface mode={picker(query)} theme={theme} columns={80} onMove={() => {}} send={(request) => requests.push(request)} />
  }
  const view = await testRender(<Harness />, { width: 80, height: 24 })
  try {
    await act(async () => { await view.waitForVisualIdle() })
    await act(async () => { setQuery("~/Documents/"); await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe("~/Documents/")
    await act(async () => { await view.mockInput.pasteBracketedText("Notes") })
    expect(nativeMenuInput.current?.plainText).toBe("~/Documents/Notes")
    await act(async () => { setQuery("~/Documents/"); await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe("~/Documents/Notes")
    await act(async () => { setQuery("./src/"); await view.waitForVisualIdle() })
    expect(nativeMenuInput.current?.plainText).toBe("./src/")
    expect(nativeMenuInput.current?.cursorOffset).toBe("./src/".length)
    expect(requests.some((request) => JSON.stringify(request).includes("./src/"))).toBe(false)
  } finally {
    await act(async () => { await view.dispose() })
  }
})
