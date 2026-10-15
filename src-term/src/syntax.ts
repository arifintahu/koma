import { addDefaultParsers, getTreeSitterClient } from "@opentui/core"
import type { Theme } from "./theme.ts"
import { fileURLToPath } from "node:url"

// Resolve the shipped worker explicitly: bundled entrypoints need not live next
// to OpenTUI's worker. All paths below are local; no runtime grammar downloads.
process.env.OTUI_TREE_SITTER_WORKER_PATH ??= fileURLToPath(import.meta.resolve("@opentui/core/parser.worker"))
for (const [filetype, aliases] of [["python", ["py", "python3"]], ["rust", ["rs"]]] as const) {
  const asset = (name: string) => fileURLToPath(new URL(`../assets/parsers/${filetype}/${name}`, import.meta.url))
  addDefaultParsers([{ filetype, aliases: [...aliases], wasm: asset(`tree-sitter-${filetype}.wasm`), queries: { highlights: [asset("highlights.scm")] } }])
}
// Keep aliases on the same shipped JS/TS grammars instead of remote descriptors.
const coreRoot = new URL(".", import.meta.resolve("@opentui/core"))
for (const [filetype, aliases, wasmName] of [
  ["javascript", ["js", "jsx", "javascriptreact"], "javascript"],
  ["typescript", ["ts"], "typescript"],
  ["typescriptreact", ["tsx"], "tsx"],
] as const) {
  const asset = (name: string) => fileURLToPath(new URL(`assets/${filetype}/${name}`, coreRoot))
  addDefaultParsers([{filetype, aliases:[...aliases], wasm:asset(`tree-sitter-${wasmName}.wasm`), queries:{highlights:[asset("highlights.scm")]}}])
}
export const syntaxClient = getTreeSitterClient()

/** Use semantic palette roles for every capture emitted by the bundled queries. */
export function syntaxStyles(theme: Theme) {
  return {
    default: { fg: theme.fg }, conceal: { fg: theme.dim },
    keyword: { fg: theme.accent, bold: true }, string: { fg: theme.success },
    comment: { fg: theme.dim, italic: true }, number: { fg: theme.warn },
    float: { fg: theme.warn }, boolean: { fg: theme.warn }, constant: { fg: theme.warn },
    function: { fg: theme.info }, method: { fg: theme.info }, constructor: { fg: theme.info },
    type: { fg: theme.info }, property: { fg: theme.fg }, variable: { fg: theme.fg },
    operator: { fg: theme.accent }, punctuation: { fg: theme.fg },
    attribute: { fg: theme.warn }, label: { fg: theme.info }, embedded: { fg: theme.fg },
    "markup.heading": { fg: theme.accent, bold: true }, "markup.strong": { bold: true },
    "markup.italic": { italic: true }, "markup.strikethrough": { dim: true },
    "markup.raw": { fg: theme.info }, "markup.link": { fg: theme.info, underline: true },
    "markup.link.label": { fg: theme.info, underline: true }, "markup.link.url": { fg: theme.info },
    "markup.list": { fg: theme.accent }, "markup.quote": { fg: theme.dim, italic: true },
  }
}
