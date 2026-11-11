import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'

it('forwards playback lifetime and resets it without retaining an indefinite listening window', () => {
 let receive!: (value: any) => void, engine: any
 class VoiceEngine { config: any; activeUntil = 0; playbackActive = false; enrolling = false; history = new Float32Array(1); historySamples = 1; vad = { reset: vi.fn() }; constructor(_directory: string, config: any) { this.config = config; engine = this } }
 const source = readFileSync(new URL('../packages/desktop/src/voice/worker.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '')
 runInNewContext(source, { VoiceEngine, Date, Float32Array, process: { on: (event: string, callback: any) => { if (event === 'message') receive = callback }, send: vi.fn(), exit: vi.fn() } })
 receive({ type: 'init', directory: '/unused', config: { followupSeconds: 30 } })
 receive({ type: 'playback', active: true }); expect(engine.playbackActive).toBe(true)
 receive({ type: 'playback', active: false }); expect(engine.playbackActive).toBe(false); expect(engine.activeUntil).toBe(0)
 receive({ type: 'followup' }); expect(engine.activeUntil).toBeGreaterThan(Date.now())
 receive({ type: 'playback', active: true }); receive({ type: 'reset' })
 expect(engine.playbackActive).toBe(false); expect(engine.activeUntil).toBe(0); expect(engine.vad.reset).toHaveBeenCalledOnce()
})
