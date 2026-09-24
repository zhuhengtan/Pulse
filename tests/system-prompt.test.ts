import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSystemPrompt,
  loadProjectInstructions,
  MAX_INSTRUCTION_BYTES,
  createLocalHost,
  validateAskReply,
} from '@hunterzhu/pulse-server'
import { parse, hostOptions } from '../packages/cli/src/bin.js'
import { defaultPulseConfig, defaultPulseConfigPath } from '../packages/cli/src/config.js'

let cliConfigHome: string
let previousCliConfigHome: string | undefined

beforeAll(async () => {
  cliConfigHome = await mkdtemp(join(tmpdir(), 'pulse-system-prompt-config-'))
  previousCliConfigHome = process.env.PULSE_HOME
  process.env.PULSE_HOME = cliConfigHome
  await writeFile(defaultPulseConfigPath(), `${JSON.stringify(defaultPulseConfig, null, 2)}\n`)
})

afterAll(async () => {
  if (previousCliConfigHome === undefined) delete process.env.PULSE_HOME
  else process.env.PULSE_HOME = previousCliConfigHome
  await rm(cliConfigHome, { recursive: true, force: true })
})

describe('system prompt and instructions discovery', () => {
  describe('ask reply validation', () => {
    it('accepts string options as declared by ask.choice and ask.multi', () => {
      expect(() => validateAskReply({ kind: 'ask', type: 'choice', options: ['safe', 'fast'] }, { value: 'fast' })).not.toThrow()
      expect(() => validateAskReply({ kind: 'ask', type: 'multi', options: ['safe', 'fast'], min: 1 }, { values: ['safe'] })).not.toThrow()
      expect(() => validateAskReply({ kind: 'ask', type: 'choice', options: ['safe', 'fast'] }, { value: 'unknown' })).toThrow('ASK_RESPONSE_INVALID:choice')
    })
  })

  describe('buildSystemPrompt', () => {
    it('generates a general-purpose prompt with workspace and task-specific discipline', () => {
      const prompt = buildSystemPrompt({ workspace: '/test/workspace' })
      expect(prompt).toContain('You are Pulse')
      expect(prompt).toContain('general-purpose task assistant')
      expect(prompt).toContain('research, organize files')
      expect(prompt).toContain('/test/workspace')
      expect(prompt).toContain('## Investigation & Tool Safety')
      expect(prompt).toContain('## Software Engineering Tasks')
      expect(prompt).toContain('## Task Execution Contract')
      expect(prompt).toContain('Work in bounded phases')
      expect(prompt).toContain('Ground answers about workspace files')
      expect(prompt).toContain('make focused edits')
      expect(prompt).toContain('On Windows, use native PowerShell via')
      expect(prompt).toContain('does not start a shell implicitly')
      expect(prompt).toContain('## Evidence-Based Verification')
      expect(prompt).toContain('## Output & Communication Style')
      expect(prompt).toContain('Reply in the same language')
    })

    it('injects Simplified Chinese language instruction when zh-CN is selected', () => {
      const prompt = buildSystemPrompt({ workspace: '/test/workspace', responseLanguage: 'zh-CN' })
      expect(prompt).toContain('Reply in Simplified Chinese')
    })

    it('injects custom system prompt from config or UI settings', () => {
      const prompt = buildSystemPrompt({
        workspace: '/test/workspace',
        systemPrompt: 'Always output JSON when possible.',
      })
      expect(prompt).toContain('## Custom System Instructions')
      expect(prompt).toContain('Always output JSON when possible.')
    })

    it('injects project-specific rules', () => {
      const prompt = buildSystemPrompt({
        workspace: '/test/workspace',
        projectRules: 'Do not touch package.json directly.',
      })
      expect(prompt).toContain('## Project-Specific Rules')
      expect(prompt).toContain('Do not touch package.json directly.')
    })

    it('injects user-level instructions', () => {
      const prompt = buildSystemPrompt({
        workspace: '/test/workspace',
        userRules: 'Prefer functional programming style.',
      })
      expect(prompt).toContain('## User-Level Instructions')
      expect(prompt).toContain('Prefer functional programming style.')
    })

    it('combines custom prompt, project rules, and user rules in order', () => {
      const prompt = buildSystemPrompt({
        workspace: '/test/workspace',
        systemPrompt: 'Custom prompt',
        projectRules: 'Project rules',
        userRules: 'User rules',
        responseLanguage: 'zh-CN',
      })
      const customIdx = prompt.indexOf('## Custom System Instructions')
      const projectIdx = prompt.indexOf('## Project-Specific Rules')
      const userIdx = prompt.indexOf('## User-Level Instructions')
      const langIdx = prompt.indexOf('Reply in Simplified Chinese')

      expect(customIdx).toBeGreaterThan(0)
      expect(projectIdx).toBeGreaterThan(customIdx)
      expect(userIdx).toBeGreaterThan(projectIdx)
      expect(langIdx).toBeGreaterThan(userIdx)
    })
  })

  describe('loadProjectInstructions', () => {
    it('discovers PULSE.md in workspace root', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'PULSE.md'), '# Pulse Rules\nFollow project conventions.')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('# Pulse Rules\nFollow project conventions.')
        expect(discovered.projectRulesPath).toBe(join(dir, 'PULSE.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('discovers .pulse/rules.md when PULSE.md is absent', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await mkdir(join(dir, '.pulse'), { recursive: true })
        await writeFile(join(dir, '.pulse', 'rules.md'), '# Nested Rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('# Nested Rules')
        expect(discovered.projectRulesPath).toBe(join(dir, '.pulse', 'rules.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('discovers CLAUDE.md when PULSE.md and .pulse/rules.md are absent', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'CLAUDE.md'), '# Claude Compatibility Rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('# Claude Compatibility Rules')
        expect(discovered.projectRulesPath).toBe(join(dir, 'CLAUDE.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('discovers AGENTS.md when higher priority rule files are absent', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'AGENTS.md'), '# Agents Standard Rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('# Agents Standard Rules')
        expect(discovered.projectRulesPath).toBe(join(dir, 'AGENTS.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('prioritizes PULSE.md over CLAUDE.md and AGENTS.md', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'PULSE.md'), 'Primary Pulse Rules')
        await writeFile(join(dir, 'CLAUDE.md'), 'Claude Rules')
        await writeFile(join(dir, 'AGENTS.md'), 'Agents Rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('Primary Pulse Rules')
        expect(discovered.projectRulesPath).toBe(join(dir, 'PULSE.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('ignores empty files and falls back to next candidate', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'PULSE.md'), '   \n\n  ')
        await writeFile(join(dir, 'CLAUDE.md'), 'Fallback Claude Rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('Fallback Claude Rules')
        expect(discovered.projectRulesPath).toBe(join(dir, 'CLAUDE.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('discovers user instructions from ~/.pulse/instructions.md', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      const home = await mkdtemp(join(tmpdir(), 'pulse-home-test-'))
      try {
        await writeFile(join(home, 'instructions.md'), 'User global preference')
        const discovered = await loadProjectInstructions(dir, home)
        expect(discovered.userRules).toBe('User global preference')
        expect(discovered.userRulesPath).toBe(join(home, 'instructions.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(home, { recursive: true, force: true })
      }
    })

    it('skips a project rule symlink that resolves outside the workspace', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      const outside = await mkdtemp(join(tmpdir(), 'pulse-rules-outside-'))
      try {
        await writeFile(join(outside, 'secret.txt'), 'secret-value')
        await symlink(join(outside, 'secret.txt'), join(dir, 'PULSE.md'))
        await writeFile(join(dir, 'AGENTS.md'), 'Safe in-workspace rules')
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBe('Safe in-workspace rules')
        expect(discovered.projectRules).not.toContain('secret-value')
        expect(discovered.projectRulesPath).toBe(join(dir, 'AGENTS.md'))
      } finally {
        await rm(dir, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      }
    })

    it('caps an in-workspace rule file', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        await writeFile(join(dir, 'PULSE.md'), `${'a'.repeat(MAX_INSTRUCTION_BYTES)}TAIL`)
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules?.endsWith('\n[instruction truncated]')).toBe(true)
        expect(discovered.projectRules).not.toContain('TAIL')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('gracefully returns undefined when no rules exist', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-rules-test-'))
      try {
        const discovered = await loadProjectInstructions(dir, join(dir, 'empty-home'))
        expect(discovered.projectRules).toBeUndefined()
        expect(discovered.userRules).toBeUndefined()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('LocalHost systemPrompt management', () => {
    it('supports getSystemPrompt and setSystemPrompt dynamically', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-host-test-'))
      try {
        const host = createLocalHost({
          cwd: dir,
          dataDir: join(dir, 'data'),
          systemPrompt: 'Initial custom prompt',
          mockResponse: 'OK',
        })
        expect(host.getSystemPrompt()).toBe('Initial custom prompt')

        host.setSystemPrompt('Updated prompt')
        expect(host.getSystemPrompt()).toBe('Updated prompt')

        host.setSystemPrompt('')
        expect(host.getSystemPrompt()).toBeUndefined()

        await host.close()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('executes a task with custom systemPrompt and project rules loaded', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-host-test-'))
      try {
        await writeFile(join(dir, 'PULSE.md'), 'Custom project rules for tests')
        const host = createLocalHost({
          cwd: dir,
          dataDir: join(dir, 'data'),
          systemPrompt: 'Keep responses short',
          mockResponse: 'Task completed',
        })
        const conversation = await host.createConversation()
        const run = await host.sendMessage(conversation.id, { text: 'Hello' })
        const events = []
        for await (const event of run.events) events.push(event)
        const outcome = await run.outcome()
        expect(outcome.status).toBe('succeeded')
        expect(outcome.text).toBe('Task completed')
        await host.close()
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })
  })

  describe('CLI arguments and configuration', () => {
    it('parses --system-prompt and --system-prompt-file from CLI argv', () => {
      const parsed = parse([
        'run',
        'do something',
        '--system-prompt',
        'Be very strict',
        '--system-prompt-file',
        './custom.md',
      ])
      expect(parsed.options['system-prompt']).toBe('Be very strict')
      expect(parsed.options['system-prompt-file']).toBe('./custom.md')
    })

    it('resolves --system-prompt into hostOptions', async () => {
      const parsed = parse(['--system-prompt', 'CLI custom prompt'])
      const options = await hostOptions(parsed)
      expect(options.systemPrompt).toBe('CLI custom prompt')
    })

    it('resolves --system-prompt-file from filesystem into hostOptions', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'pulse-cli-test-'))
      try {
        const filePath = join(dir, 'prompt.md')
        await writeFile(filePath, 'Prompt from file')
        const parsed = parse(['--cwd', dir, '--system-prompt-file', filePath])
        const options = await hostOptions(parsed)
        expect(options.systemPrompt).toBe('Prompt from file')
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    })

    it('throws error when --system-prompt-file does not exist', async () => {
      const parsed = parse(['--system-prompt-file', '/nonexistent/path/to/prompt.md'])
      await expect(hostOptions(parsed)).rejects.toThrow('SYSTEM_PROMPT_FILE_NOT_FOUND')
    })
  })
})
