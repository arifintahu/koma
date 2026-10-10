import '../styles.css'
import { expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-react'
import { formatPasteFence } from '../lib/pasteText'
import { useKoma } from '../store/koma'

vi.mock('./Composer', () => ({ Composer: () => null }))

import { ChatView } from './ChatView'

it.each([
  ['mid-sentence', 'before ', ' < we should remove this logic?'],
  ['paste-only', '', ''],
])('keeps the %s paste reference in the sent message and its card expandable', async (_name, before, after) => {
  const body = "error: couldn't read models.json\nfull pasted details"
  const fence = formatPasteFence({ n: 9, path: 'pastes/09-paste.txt', text: body })
  useKoma.setState((state) => ({
    req: vi.fn(),
    session: {
      ...state.session,
      id: 'paste-reference',
      messages: [{ role: 'user', content: `${before}${fence}${after}`, reasoning: null }],
      working: false, stream: '', reasoning: '', hasMoreOlder: false,
      attachments: [], pendingSteer: [], awaitingApproval: false,
    },
  }))
  const screen = await render(<ChatView />)
  const expected = `${before}[Pasted Text #9]${after}`
  const band = document.querySelector('.bg-koma-band')!
  expect(band).not.toBeNull()
  expect(band.textContent).toBe(expected)
  expect(band.textContent).not.toContain('<<<pasted_text')
  expect(band.textContent).not.toContain(body)

  // Check the real Markdown renderer after the lazy plain-text upgrade too.
  await expect.poll(() => band.querySelector('p')).not.toBeNull()
  expect(band.textContent).toBe(expected)

  const card = screen.getByRole('button', { name: /Pasted Text #9/ })
  await expect.element(card).toHaveAttribute('aria-expanded', 'false')
  await card.click()
  await expect.element(card).toHaveAttribute('aria-expanded', 'true')
  expect(document.querySelector('article pre')?.textContent).toBe(body)
  expect(band.textContent).toBe(expected)
})
