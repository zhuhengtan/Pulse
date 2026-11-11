import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error The evaluator is an independent ESM entrypoint.
import { loadHostModelConfig } from './real-task/runner.mjs'
const roots: string[] = []
const original = process.env.PULSE_CONFIG
afterEach(async () => { if (original === undefined) delete process.env.PULSE_CONFIG; else process.env.PULSE_CONFIG = original; for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it.each(['ollama', 'deepseek'])('uses the explicitly configured %s reviewer without borrowing worker credentials', async provider => {
 const root = await mkdtemp(join(tmpdir(), 'pulse-real-config-')); roots.push(root)
 process.env.PULSE_CONFIG = join(root, 'config.json')
 await writeFile(process.env.PULSE_CONFIG, JSON.stringify({ activeModel: 'worker/m', providers: { worker: { provider: 'deepseek', apiKey: 'fake-worker', models: { m: { modelCode: 'worker-code' } } }, review: { provider, apiKey: 'fake-review', models: { r: { modelCode: 'review-code' } } } }, approvalReview: { model: 'review/r', timeoutMs: 15000 } }))
 const config = await loadHostModelConfig()
 expect(config.approvalReview).toMatchObject({ provider, model: 'review-code', apiKey: 'fake-review', timeoutMs: 30000 })
 expect(config.provider.apiKey).toBe('fake-worker')
})
