import { describe, expect, it, vi } from 'vitest'
const config = vi.hoisted(() => ({ read: vi.fn(() => { throw new Error('configuration must not be consulted for notebooks') }) }))
vi.mock('./coding-config', () => ({ getCodingConfig: config.read, editorPreferences: vi.fn() }))
vi.mock('./coding-language', () => ({ queryCodingLanguage: vi.fn() }))
import { formatBeforeSave } from './coding-save'

describe('notebook save authority', () => {
  it('bypasses file formatters without parsing or reserializing the notebook', async () => {
    const content = '{\r\n "nbformat":4,"metadata":{"exact":9007199254740993},"cells":[]\r\n}\r\n'
    expect(await formatBeforeSave({ hostId: 'local', root: '/workspace' }, 'notebook.IPYNB', content)).toBe(content)
    expect(config.read).not.toHaveBeenCalled()
  })
  it('does not bypass an ordinary file with notebook text in its name', async () => {
    await expect(formatBeforeSave({ hostId: 'local', root: '/workspace' }, 'notebook.ipynb.py', 'x=1')).rejects.toThrow('configuration must not be consulted')
    expect(config.read).toHaveBeenCalled()
  })
})
