import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalHost, type LocalHostOptions, type RunHandle } from '../packages/server/src/index.js'
import { startH5WorkWorker } from '../packages/server/src/h5/work-worker.js'
import { createBuiltinSkillCapabilityPack } from '../packages/server/src/builtin-skills.js'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'
let root: string
const workers = new Set<RunHandle>()
let closeFixtureHost: (() => Promise<void>) | undefined
afterEach(async () => {
  // A timed-out assertion does not stop its CLI worker. Close only the workers
  // owned by this fixture before removing a cwd that Windows may still lock.
  try { await Promise.all([...workers].map(handle => handle.shutdown?.())) }
  finally {
    try { await closeFixtureHost?.() }
    finally {
      workers.clear(); closeFixtureHost = undefined; vi.unstubAllEnvs()
      if (root) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
}, process.platform === 'win32' ? 30_000 : 10_000)
it('creates a draft, installs it via the built-in creator, then materializes and executes it through real CLI workers', async () => {
  root = await mkdtemp(join(tmpdir(), 'pulse-skill-worker-')); vi.stubEnv('PULSE_HOME', root)
  const dataDir = join(root, 'data'), configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ providers: { mock: { provider: 'mock', name: 'Mock' } }, models: { mock: { displayName: 'mock', provider: 'mock', modelCode: 'mock' } }, activeModel: 'mock', approvalMode: 'auto', capabilities: { enabled: [], skills: [] } }))
  await mkdir(join(root, 'draft'))
  const common: LocalHostOptions = { cwd: root, dataDir, skillConfigPath: configPath, taskController: false, approvalMode: 'auto', jarvis: { enabled: false }, capabilityPacks: [createBuiltinSkillCapabilityPack(), createSkillCapabilityPack()], enabledCapabilityPacks: ['builtin-skills'], capabilityConfig: { skills: [] }, mockAfterToolResponse: 'complete' }
  const host = createLocalHost(common)
  let closing: Promise<void> | undefined
  const closeHost = () => closing ??= host.close()
  closeFixtureHost = closeHost
  const conversation = await host.createConversation()
  try {
    const run = async (text: string, mockToolCalls: LocalHostOptions['mockToolCalls']) => {
      host.applyLiveOptions({ ...common, mockToolCalls }); await host.listSkills()
      const handle = await startH5WorkWorker({ entry: fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)), configPath, dataDir, cwd: root, approvalMode: 'auto', runtimeOptions: host.getWorkWorkerOptions() }, { conversationId: conversation.id, text })
      workers.add(handle)
      if (process.env.CI) console.info(`[skill-worker] ${text}`)
      for await (const _ of handle.events) { /* wait for the worker */ }
      expect(await handle.outcome()).toMatchObject({ status: 'succeeded' })
    }
    await run('/skill-creator Create this demo draft', [{ name: 'fs.write', input: { path: 'draft/SKILL.md', content: '---\nname: demo\ndescription: A worker-created skill\n---\nRead references/guide.md with skills.read, materialize assets with skills.materialize.' } }])
    await mkdir(join(root, 'draft/references')); await writeFile(join(root, 'draft/references/guide.md'), 'real worker reference')
    await mkdir(join(root, 'draft/scripts')); await writeFile(join(root, 'draft/scripts/run.mjs'), 'import { writeFileSync } from "node:fs"; writeFileSync("skill-executed.txt", "skill-worker-ok"); console.log("skill-worker-ok")')
    await run('/skill-creator Validate this draft', [{ name: 'skills.validate', input: { directory: 'draft' } }])
    await run('/skill-creator Install this draft', [{ name: 'skills.installLocal', input: { directory: 'draft' } }])
    expect(await host.listSkills()).toContain('demo')
    expect(JSON.parse(await readFile(configPath, 'utf8')).capabilities).toMatchObject({ enabled: ['skills'], skills: ['demo'] })
    await run('/demo Prepare this skill', [{ name: 'skills.materialize', input: { skill: 'demo', destination: 'trial' } }])
    expect(await readFile(join(root, 'trial/references/guide.md'), 'utf8')).toBe('real worker reference')
    await run('/demo Execute the prepared helper', [{ name: 'shell.exec', input: { command: 'node', args: ['trial/scripts/run.mjs'] } }])
    expect(await readFile(join(root, 'skill-executed.txt'), 'utf8')).toBe('skill-worker-ok')
    const history = await host.getConversationMessages(conversation.id)
    expect(history.filter(item => item.role === 'assistant').length).toBeGreaterThanOrEqual(5)
  } finally { await closeHost() }
}, process.platform === 'win32' ? 240_000 : 40_000)
