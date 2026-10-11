import { describe, expect, it } from 'vitest'
import { shortInterpreterLabel } from './notebook-kernel-picker'

describe('notebook kernel picker labels (VS Code–style)', () => {
  it('shows Select Kernel when empty', () => {
    expect(shortInterpreterLabel(null)).toBe('Select Kernel')
    expect(shortInterpreterLabel('')).toBe('Select Kernel')
  })

  it('shortens venv and plain paths', () => {
    expect(shortInterpreterLabel('/Users/a/proj/.venv/bin/python')).toBe('.venv')
    expect(shortInterpreterLabel('C:\\proj\\venv\\Scripts\\python.exe')).toBe('venv')
    expect(shortInterpreterLabel('/usr/bin/python3')).toBe('python3')
    expect(shortInterpreterLabel('/opt/homebrew/bin/python3.12')).toBe('python3.12')
  })
})
