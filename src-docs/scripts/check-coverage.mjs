import fs from 'node:fs'
import path from 'node:path'

const docsRoot = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(docsRoot, '..')
const commandRs = fs.readFileSync(path.join(repoRoot, 'src-agent/src/controller/command.rs'), 'utf8')

function table(name) {
  const start = commandRs.indexOf(`pub const ${name}`)
  if (start < 0) throw new Error(`missing ${name} in command.rs`)
  const body = commandRs.slice(start, start + commandRs.slice(start).indexOf('];'))
  return [...body.matchAll(/\(\s*\n?\s*"([^"]+)"/g)].map((match) => match[1])
}

function walk(dir) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...walk(full))
    else if (entry.name.endsWith('.mdx')) files.push(full)
  }
  return files
}

function frontmatter(text) {
  const match = text.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const data = {}
  for (const line of match[1].split('\n')) {
    const split = line.indexOf(':')
    if (split < 0) continue
    let value = line.slice(split + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    data[line.slice(0, split).trim()] = value
  }
  return data
}

const commands = table('COMMANDS')
const keys = table('KEYBINDINGS')
const pages = walk(path.join(docsRoot, 'src/pages'))
const referenceDir = path.join(docsRoot, 'src/pages/reference/commands')
const referencePages = fs.existsSync(referenceDir) ? walk(referenceDir) : []
const found = new Map()
for (const file of referencePages) {
  const data = frontmatter(fs.readFileSync(file, 'utf8'))
  if (!data.command) continue
  found.set(data.command, file)
}

const missing = []
for (const command of commands) {
  if (!found.has(command)) missing.push(`command ${command} has no reference page`)
}
for (const [command, file] of found) {
  if (!commands.includes(command)) missing.push(`unexpected reference command ${command} in ${path.relative(docsRoot, file)}`)
}

const keysPage = path.join(docsRoot, 'src/pages/reference/keys.mdx')
const keysText = fs.existsSync(keysPage) ? fs.readFileSync(keysPage, 'utf8') : ''
const extraKeys = ['Shift+Tab', 'Shift+Enter', 'Ctrl+C', '@']
for (const key of [...keys, ...extraKeys]) {
  if (!keysText.includes(`| ${key} |`)) missing.push(`key ${key} is missing from reference/keys.mdx`)
}

const book = pages.map((file) => fs.readFileSync(file, 'utf8')).join('\n')
const modes = ['Auto', 'Normal', 'Planning', 'SDLC', 'Yooloo']
const themes = ['dark', 'light', 'forest', 'autumn', 'warm', 'cold symphony', 'winter', 'monokai', 'vscode', 'github dark']
const fields = [
  'Session name',
  'Workdir',
  'Awareness',
  'Harness',
  'Allowed dirs',
  'Short-send',
  'Bash shorts',
  'Coding autosave',
  'Internet mode',
  'Web search',
  'Mouse capture',
  'Max turns',
  'Max out tokens',
]
for (const item of [...modes, ...themes, ...fields]) {
  if (!book.includes(item)) missing.push(`missing from the book: ${item}`)
}

const capturedDir = path.join(docsRoot, 'src/captured')
for (const file of fs.readdirSync(capturedDir).filter((name) => name.endsWith('.json'))) {
  const frame = JSON.parse(fs.readFileSync(path.join(capturedDir, file), 'utf8'))
  const expected = file === 'too-narrow.json' ? [42, 24] : [80, 38]
  if (frame.cols !== expected[0] || frame.rows !== expected[1]) {
    missing.push(`${file} is ${frame.cols}x${frame.rows}, expected ${expected[0]}x${expected[1]}`)
  }
  const lines = String(frame.ansi ?? '').split('\n')
  if (lines.length !== expected[1]) missing.push(`${file} has ${lines.length} lines`)
}

const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src-core-sdk/protocol/schema.json'), 'utf8'))
const sdkMethods = []
for (const name of Object.keys(schema.$defs ?? {})) {
  const def = schema.$defs[name]
  const method = def?.properties?.method?.const
  if (method) sdkMethods.push(method)
}
const request = schema.$defs?.request
const oneOf = request?.oneOf ?? request?.anyOf ?? []
for (const branch of oneOf) {
  const method = branch?.properties?.method?.const
  if (method) sdkMethods.push(method)
}
const uniqueMethods = [...new Set(sdkMethods)]
const sdkDir = path.join(docsRoot, 'src/pages/sdk/reference')
const sdkFound = new Map()
for (const file of fs.existsSync(sdkDir) ? walk(sdkDir) : []) {
  const data = frontmatter(fs.readFileSync(file, 'utf8'))
  if (data.method) sdkFound.set(data.method, file)
}
for (const method of uniqueMethods) {
  if (!sdkFound.has(method)) missing.push(`sdk method ${method} has no reference page`)
}

const grants = [
  'agents:read',
  'agents:orchestrate',
  'sessions:manage',
  'chat:prompt',
  'models:invoke',
  'context:publish',
  'models:contribute',
  'oauth:contribute',
]
const grantDir = path.join(docsRoot, 'src/pages/extension/grants')
const grantFound = new Set()
for (const file of fs.existsSync(grantDir) ? walk(grantDir) : []) {
  const data = frontmatter(fs.readFileSync(file, 'utf8'))
  if (data.grant) grantFound.add(data.grant)
}
for (const grant of grants) {
  if (!grantFound.has(grant)) missing.push(`extension grant ${grant} has no page`)
}

const sampleRoot = path.join(repoRoot, 'src-extension/example')
const sampleDir = path.join(docsRoot, 'src/pages/extension/samples')
const sampleFound = new Set()
for (const file of fs.existsSync(sampleDir) ? walk(sampleDir) : []) {
  const data = frontmatter(fs.readFileSync(file, 'utf8'))
  if (data.sample) sampleFound.add(data.sample)
}
for (const name of fs.readdirSync(sampleRoot)) {
  const full = path.join(sampleRoot, name)
  if (!fs.statSync(full).isDirectory()) continue
  if (!sampleFound.has(name)) missing.push(`extension sample ${name} has no page`)
}

if (missing.length) {
  console.error(missing.join('\n'))
  process.exit(1)
}

console.log(`coverage ok: ${commands.length} commands, ${keys.length + extraKeys.length} keys, ${modes.length} modes, ${themes.length} themes, ${fields.length} settings, ${uniqueMethods.length} sdk methods, ${grants.length} grants`)
