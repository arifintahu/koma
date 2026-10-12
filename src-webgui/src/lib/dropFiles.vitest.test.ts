import { expect, it } from 'vitest'
import {
  COMPOSER_FILE_ACCEPT,
  decodeDroppedText,
  dropFileLabel,
  previewDroppedFile,
} from './dropFiles'

it('treats image extensions as images even with an empty MIME', () => {
  expect(previewDroppedFile('shot.png', '', 12)).toBe('image')
  expect(previewDroppedFile('shot.PNG', 'application/octet-stream', 12)).toBe('image')
})

it('keeps svg on the text path', () => {
  expect(previewDroppedFile('icon.svg', 'image/svg+xml', 20)).toBe('text')
})

it('accepts text extensions and opaque files, rejects zip and oversized files', () => {
  expect(previewDroppedFile('notes.md', '', 4)).toBe('text')
  expect(previewDroppedFile('Makefile', '', 4)).toBe('text')
  expect(previewDroppedFile('archive.zip', 'application/zip', 4)).toBe('reject')
  expect(previewDroppedFile('big.txt', 'text/plain', 2 * 1024 * 1024 + 1)).toBe('reject')
  expect(COMPOSER_FILE_ACCEPT).toContain('image/*')
  expect(COMPOSER_FILE_ACCEPT).toContain('.md')
})

it('decodes UTF-8 text and rejects NUL or invalid bytes', () => {
  expect(decodeDroppedText(new TextEncoder().encode('hi\n'))).toBe('hi\n')
  expect(decodeDroppedText(Uint8Array.from([0x68, 0x00]))).toBeNull()
  expect(decodeDroppedText(Uint8Array.from([0xff, 0xfe]))).toBeNull()
  expect(dropFileLabel('dir/notes.md')).toBe('notes.md')
  expect(dropFileLabel('')).toBe('file')
})
