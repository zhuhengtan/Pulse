import { z } from 'zod'
import { defineTool, type ToolDefinition } from '@hunterzhu/pulse-tool-sdk'
import { mkdir, rename, rm, lstat } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { within } from './security.js'
import { snapshot, skillPath, utf8, readSkillDirectory, writeSkillFiles, publishSkill, type SkillSnapshot } from './skill-store.js'

export function createSkillTools(skills: Map<string, SkillSnapshot>, workspace: string, options: { mode: string; approved: (id: string) => boolean; enable: (name: string) => Promise<void>; protectedNames: readonly string[]; beforeInstall?: (name: string) => Promise<void> }): ToolDefinition[] {
  if (!skills.size) return []
  function get(name: string) { const value = skills.get(name); if (!value) throw new Error('SKILL_NOT_SELECTED'); return value }
  function authorize(id: string, name: string) {
    if (options.mode === 'read-only') throw new Error('TOOL_DISABLED_READ_ONLY:' + name)
    if (options.mode === 'ask' && !options.approved(id)) throw new Error('APPROVAL_REQUIRED:' + name)
  }
  const tools: ToolDefinition[] = [defineTool({
    name: 'skills.read', description: 'Read a UTF-8 reference from a skill selected for this run. Paths are relative to the skill. Binary assets must be materialized.',
    input: z.object({ skill: z.string(), path: z.string(), offset: z.number().int().min(0).default(0) }), output: z.object({ content: z.string(), nextOffset: z.number().nullable() }), sideEffectPolicy: 'read',
    execute: ({ skill, path, offset = 0 }) => {
      const file = get(skill).files.get(skillPath(path)); if (!file) throw new Error('SKILL_RESOURCE_NOT_FOUND')
      const text = utf8(file), end = Math.min(text.length, offset + 16000)
      return { content: text.slice(offset, end), nextOffset: end < text.length ? end : null }
    },
  }), defineTool({
    name: 'skills.materialize', description: 'Copy the complete selected skill snapshot (scripts, references and binary assets) into a NEW workspace directory. Then use shell.exec with argv to run scripts; normal approvals, sandbox and network policy still apply. Dependencies are not installed.',
    input: z.object({ skill: z.string(), destination: z.string().min(1) }), output: z.object({ path: z.string(), files: z.array(z.string()) }), sideEffectPolicy: 'write', resolveResources: () => [{ resource: 'workspace', mode: 'exclusive' }],
    execute: async ({ skill, destination }, context) => {
      authorize(context.toolCallId, 'skills.materialize')
      const selected = get(skill), target = await within(workspace, destination)
      if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('SKILL_DESTINATION_EXISTS')
      const stage = join(dirname(target), `.skill-${randomUUID()}`)
      try { await mkdir(stage); await writeSkillFiles(stage, selected.files); await rename(stage, target) } finally { await rm(stage, { recursive: true, force: true }) }
      return { path: target, files: [...selected.files.keys()] }
    },
  })]
  if (skills.has('skill-creator')) {
    tools.push(defineTool({
      name: 'skills.validate', description: 'Validate a skill draft directory inside the current workspace: metadata, paths, file limits, and referenced files. Does not execute scripts or install anything.',
      input: z.object({ directory: z.string() }), output: z.object({ valid: z.boolean(), name: z.string().optional(), warnings: z.array(z.string()), error: z.string().optional() }), sideEffectPolicy: 'read',
      execute: async ({ directory }) => { try { const skill = snapshot(await readSkillDirectory(await within(workspace, directory))); return { valid: skill.warnings.length === 0, name: skill.name, warnings: skill.warnings } } catch (error) { return { valid: false, warnings: [], error: error instanceof Error ? error.message : 'SKILL_INVALID' } } },
    }), defineTool({
      name: 'skills.installLocal', description: 'Install a validated workspace skill draft into the Pulse user skill directory and enable it. Use when the user requests installation. Never overwrites an existing skill.',
      input: z.object({ directory: z.string() }), output: z.object({ name: z.string(), hash: z.string(), warnings: z.array(z.string()) }), sideEffectPolicy: 'external', resolveResources: () => [{ resource: 'workspace', mode: 'exclusive' }, { resource: 'skill-store', mode: 'exclusive' }],
      execute: async ({ directory }, context) => {
        authorize(context.toolCallId, 'skills.installLocal')
        const skill = snapshot(await readSkillDirectory(await within(workspace, directory)))
        if (skill.warnings.length) throw new Error('SKILL_REFERENCES_INVALID')
        await options.beforeInstall?.(skill.name)
        await publishSkill(skill, { enable: options.enable, protectedNames: options.protectedNames })
        return { name: skill.name, hash: skill.hash, warnings: skill.warnings }
      },
    }))
  }
  return tools
}
