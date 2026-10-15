import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { act } from "react"
import { testRender } from "@opentui/react/test-utils"
import { addDirArgument, directoryToList, guideFolders, listChildFolders } from "./dirs.ts"
import { FolderGuide } from "./dirs.tsx"
import { themeFor } from "./theme.ts"

test("the adddir guide reads the path and lists that directory", () => {
  expect(addDirArgument("/adddir")).toBeNull()
  expect(addDirArgument("/adddir ")).toBeNull()
  expect(addDirArgument("/help ~/Project")).toBeNull()
  expect(addDirArgument("/adddir ~/Project")).toBe("~/Project")
  expect(addDirArgument("/add-dir ~/Project")).toBe("~/Project")
  expect(addDirArgument("/adddir /")).toBe("/")
  expect(addDirArgument("/adddir /home")).toBe("/home")
  expect(addDirArgument("/adddir ~/")).toBe("~/")
  expect(addDirArgument("/adddir ./")).toBe("./")
  expect(directoryToList("~/Project", "/work", "/Users/me")).toBe("/Users/me/Project")
  expect(directoryToList("~/", "/work", "/Users/me")).toBe("/Users/me")
  expect(directoryToList("~", "/work", "/Users/me")).toBe("/Users/me")
  expect(directoryToList("~other", "/work", "/Users/me")).toBeNull()
  expect(directoryToList("./", "/work", "/Users/me")).toBe("/work")
  expect(directoryToList("src", "/work", "/Users/me")).toBe("/work/src")
  expect(directoryToList("/", "/work", "/Users/me")).toBe("/")
  expect(directoryToList("/home", "/work", "/Users/me")).toBe("/home")
})

test("a directory guide lists folders inside the typed path and skips files", async () => {
  const root = mkdtempSync(join(tmpdir(), "koma-adddir-"))
  const project = join(root, "Project")
  mkdirSync(join(project, "src"), { recursive: true })
  mkdirSync(join(project, "notes"), { recursive: true })
  mkdirSync(join(project, ".hidden"), { recursive: true })
  writeFileSync(join(project, "readme.txt"), "hi")
  try {
    expect(await listChildFolders(project)).toEqual(["notes", "src"])
    expect(await listChildFolders(join(project, "missing"))).toBeNull()
    expect(await guideFolders("Project", root)).toEqual(["notes", "src"])
    expect(await guideFolders("P", root)).toEqual(["Project"])
    expect(await guideFolders("Project/s", root)).toEqual(["src"])
    expect(await guideFolders("Project/z", root)).toEqual([])
    const theme = themeFor("forest")
    const view = await testRender(<FolderGuide draft={`/adddir ${project}/s`} cwd={root} theme={theme} />, { width: 80, height: 16 })
    try {
      await act(async () => { await Bun.sleep(80) })
      await act(async () => { await view.waitForVisualIdle() })
      const frame = view.captureCharFrame()
      expect(frame).toContain("src")
      expect(frame).not.toContain("notes")
      expect(frame).not.toContain("readme.txt")
      expect(frame).not.toContain(".hidden")
      const quiet = await testRender(<FolderGuide draft="/adddir" cwd={root} theme={theme} />, { width: 80, height: 12 })
      try {
        await act(async () => { await Bun.sleep(80) })
        expect(quiet.captureCharFrame().trim()).toBe("")
      } finally {
        await act(async () => { await quiet.dispose() })
      }
    } finally {
      await act(async () => { await view.dispose() })
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
