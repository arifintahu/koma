# Offline parser assets

Python and Rust WASM parsers are vendored from the exact `tree-sitter-wasms`
0.1.13 archive. The matching highlight queries come from Python v0.21.0 and
Rust v0.20.4. `manifest.json` pins the source releases and SHA-256 of every
asset and the original archive. Grammar/query licenses are included per language.
The prebuilt WASM distribution is published under the Unlicense.

JavaScript, TypeScript and TSX continue to use OpenTUI's shipped local assets.
`src/syntax.ts` registers local paths and aliases before starting the shipped
worker. These languages require no runtime downloads. Unknown languages render
as framed plain text. Changes must pass real parser and captured native span
tests with network access unavailable.
