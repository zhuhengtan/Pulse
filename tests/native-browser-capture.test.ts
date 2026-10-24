import { expect, it, vi } from 'vitest'
// @ts-expect-error desktop ESM module
import { captureNativePage } from '../packages/desktop/src/native-capture.mjs'

const frame = { isEmpty: () => false }
function contents() { return { capturePage: vi.fn(), isDestroyed: () => false } }

it('waits for the first composited frame after navigation without accepting an empty image', async () => {
  const wc = contents()
  wc.capturePage.mockRejectedValueOnce(new Error('UnknownVizError')).mockResolvedValueOnce({ isEmpty: () => true }).mockResolvedValueOnce(frame)
  const captured = captureNativePage(wc)
  expect(await captured).toBe(frame)
  expect(wc.capturePage).toHaveBeenCalledTimes(3)
})

it('bounds transient frame retries and preserves the capture failure', async () => {
  const wc = contents(), error = new Error('UnknownVizError')
  wc.capturePage.mockRejectedValue(error)
  const rejection = expect(captureNativePage(wc)).rejects.toBe(error)
  await rejection
  expect(wc.capturePage).toHaveBeenCalledTimes(4)
})

it('does not retry a closed tab or unrelated capture errors', async () => {
  for (const [destroyed, message] of [[true, 'UnknownVizError'], [false, 'BROWSER_RENDERER_STOPPED']] as const) {
    const wc = contents(), error = new Error(message)
    wc.isDestroyed = () => destroyed
    wc.capturePage.mockRejectedValue(error)
    await expect(captureNativePage(wc)).rejects.toBe(error)
    expect(wc.capturePage).toHaveBeenCalledTimes(1)
  }
})
