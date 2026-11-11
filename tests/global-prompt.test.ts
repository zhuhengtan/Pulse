import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSystemPrompt, createLocalHost, loadProjectInstructions } from '../packages/server/src/index.js'
import { clearGlobalPrompt, readGlobalPrompt, writeGlobalPrompt } from '../packages/server/src/global-prompt-store.js'

/** resolveSystemPrompt is private on the host; tests drive it through the same shape the runtime uses. */
type PromptResolver = { resolveSystemPrompt: (workspace: string) => Promise<string> }

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'pulse-global-prompt-'))
  roots.push(home)
  vi.stubEnv('PULSE_HOME', home)
  const workspace = join(home, 'workspace')
  await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'PULSE.md'), 'Use the repository scripts.\n')
  await writeFile(join(home, 'instructions.md'), 'Prefer small diffs.\n')
  const host = createLocalHost({ cwd: workspace, dataDir: join(home, 'data') })
  return {
    home,
    workspace,
    resolve: (target: string = workspace) => (host as unknown as PromptResolver).resolveSystemPrompt(target),
  }
}

describe('resolveSystemPrompt global prompt wiring', () => {
  it('inserts the stored global prompt between project rules and user-level instructions', async () => {
    const { resolve } = await fixture()
    await writeGlobalPrompt('Always answer in the user language and cite file paths.')
    const prompt = await resolve()
    const global = prompt.indexOf('## Global Instructions')
    expect(global).toBeGreaterThan(prompt.indexOf('## Project-Specific Rules'))
    expect(global).toBeLessThan(prompt.indexOf('## User-Level Instructions'))
    expect(prompt).toContain('Always answer in the user language and cite file paths.')
  })

  it('leaves the assembled prompt unchanged when the global prompt is unset or cleared', async () => {
    const { workspace, resolve } = await fixture()
    const instructions = await loadProjectInstructions(workspace)
    const baseline = buildSystemPrompt({
      workspace,
      projectInstructions: instructions.projectRules,
      userInstructions: instructions.userRules,
    })
    const unset = await resolve()
    expect(unset).not.toContain('## Global Instructions')
    expect(unset).toBe(baseline)
    await writeGlobalPrompt('temporary rule that must not survive clearing')
    expect(await resolve()).not.toBe(baseline)
    await clearGlobalPrompt()
    expect((await readGlobalPrompt()).configured).toBe(false)
    expect(await resolve()).toBe(baseline)
  })

  it('ignores a whitespace-only global prompt', async () => {
    const { resolve } = await fixture()
    await writeGlobalPrompt('   \n\t ')
    const prompt = await resolve()
    expect(prompt).not.toContain('## Global Instructions')
  })
})
