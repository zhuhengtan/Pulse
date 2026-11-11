import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { startChatAcknowledgement } from '../packages/server/src/chat-acknowledgement.js'

const ackSource = readFileSync(new URL('../packages/server/src/chat-acknowledgement.ts', import.meta.url), 'utf8')
const chatCss = readFileSync(new URL('../packages/web/src/chat-surface.css', import.meta.url), 'utf8')
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('chat acknowledgement has no canned sentence', () => {
  it('persists nothing when the model produced no text and the caller passed no fallback', async () => {
    const persist = vi.fn(async (_text: string) => {})
    const stop = startChatAcknowledgement(persist, undefined, '', 0)
    await sleep(20)
    await stop()
    expect(persist).not.toHaveBeenCalled()
  })

  it('treats whitespace-only model output as empty', async () => {
    const persist = vi.fn(async (_text: string) => {})
    const stop = startChatAcknowledgement(persist, async () => '   ', '', 0)
    await sleep(20)
    await stop()
    expect(persist).not.toHaveBeenCalled()
  })

  it('persists the generated model text when one exists', async () => {
    const persist = vi.fn(async (_text: string) => {})
    const stop = startChatAcknowledgement(persist, async () => '好的，我这就去查。', '', 0)
    await sleep(20)
    await stop()
    expect(persist).toHaveBeenCalledTimes(1)
    expect(persist.mock.calls[0]?.[0]).toBe('好的，我这就去查。')
  })

  it('source no longer contains the removed canned line', () => {
    expect(ackSource).not.toContain('我整理一下')
  })
})

describe('chat timestamp row keeps its height', () => {
  it('reserves footer height and toggles only visibility on hover', () => {
    expect(chatCss).toMatch(/\.message--chat\s+\.message-footer\s*\{[^}]*min-height:\s*24px/)
    expect(chatCss).toMatch(/\.message--chat\s+\.message-time[^{}]*\{[^}]*visibility:\s*hidden/)
    expect(chatCss).toMatch(/:hover\s+\.message-time[^{}]*\{[^}]*visibility:\s*visible/)
  })

  it('never hides the chat timestamp with display:none, which would collapse the row', () => {
    expect(chatCss).not.toMatch(/\.message--chat\s+\.message-time[^{}]*\{[^}]*display:\s*none/)
  })
})
