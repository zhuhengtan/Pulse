import { describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBuiltinSkillCapabilityPack,
  isBuiltinSkill,
  listBuiltinSkills,
  readBuiltinSkill,
} from '../packages/server/src/builtin-skills.js'
import { createSkillCapabilityPack } from '../packages/server/src/skill-pack.js'

describe('built-in skills', () => {
  it('ships grill-and-plan with no external skills directory', async () => {
    expect(listBuiltinSkills()).toContain('grill-and-plan')
    expect(isBuiltinSkill('grill-and-plan')).toBe(true)
    const content = readBuiltinSkill('grill-and-plan')?.content ?? ''
    expect(content).toContain('ONE plan-changing question per turn')
    expect(content).toContain('ask.choice')
    expect(content).toContain('执行')
    expect(content).toContain('暂不执行')
    expect(content).toContain('keeps the already-written plan')
    expect(content).not.toContain('changes nothing')
    expect(content).toContain('git status --short')
    expect(content).not.toContain('git status, layout')
    expect(content).toContain('never mix an ask interaction with any other tool')
    expect(content).toContain('ASK_MIXED_TOOL_CALLS')
    expect(content).toContain('larger than 2048 UTF-8 bytes')
    expect(content).toContain('ONE plan.write call')
    expect(content).toContain('Use plan.write, never fs.write or fs.stage')
    expect(content).toContain('creates the parent directory automatically')
    expect(content).toContain('never overwrites an existing plan')
    expect(content).toContain('read the file back and preview')
    const pack = createBuiltinSkillCapabilityPack()
    expect(pack.manifest).toMatchObject({ id: 'builtin-skills', kind: 'skill' })
    expect(await pack.discoverSkills!({})).toContain('grill-and-plan')
    const activation = await pack.activate({
      workspaceRoot: process.cwd(),
      config: {},
      selectedSkills: ['grill-and-plan'],
      signal: new AbortController().signal,
    })
    expect(activation.tools).toEqual([])
    expect(activation.instructions?.[0]).toContain('docs/plans/<topic>.md')
  })

  it('never lets a same-named external skill override the built-in one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-builtin-'))
    try {
      await mkdir(join(root, 'grill-and-plan'))
      await writeFile(join(root, 'grill-and-plan', 'SKILL.md'), 'override attempt')
      const pack = createSkillCapabilityPack({ trustedRoots: [root] })
      expect(await pack.discoverSkills!({})).not.toContain('grill-and-plan')
      const activation = await pack.activate({
        workspaceRoot: root,
        config: {},
        selectedSkills: ['grill-and-plan'],
        signal: new AbortController().signal,
      })
      expect(activation.instructions).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
