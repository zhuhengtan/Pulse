#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalHostOptions } from '@hunterzhu/pulse-server'
import { ensurePulseUserConfig, expandHome, loadPulseConfig, type PulseCliModel, type PulseCliProviderProfile } from './config.js'
import { runInteractive } from './commands/interactive.js'
import { runOneShot } from './commands/run.js'
import { runDoctor } from './commands/doctor.js'
import { runSessions } from './commands/sessions.js'
import { runResume } from './commands/resume.js'
import { runSetup } from './commands/setup.js'

const packageManifest = createRequire(import.meta.url)('../package.json') as { version: string }
export const version = packageManifest.version

process.stdout.on('error', (error) => {
  if ((error as NodeJS.ErrnoException).code !== 'EPIPE') process.exitCode = 1
})

const help = `Pulse ${version}

Usage:
  pulse [options]                         start an interactive conversation
  pulse --resume                          enter the latest saved session and recover an unfinished run
  pulse run <task> [options]              run one task
  pulse sessions [options]                list saved conversations
  pulse resume <conversation-id> [task]    continue or recover a conversation
  pulse doctor [options]                  check local configuration

Options:
  --cwd <path>              workspace directory
  --data-dir <path>         Pulse data directory
  --config <path>           user configuration file (default home/.pulse/config.json)
  --model <name>            Pulse model display name
  --context-tokens <n>      model context window (default 32000)
  --max-output-tokens <n>   maximum generated tokens (default 4096)
  --reasoning-effort <x>    low, medium, or high
  --max-turns <n>           maximum ReAct model/tool turns (default 32)
  --auto-compact-percent <n> compact automatically at this percent of the context window (1-90, default 90)
  --format <text|jsonl>     output format
  --resume                  enter the latest saved session
  --read-only               disable write and shell tools
  --auto-approve             approve local writes and shell execution on your behalf
  --approval-mode <mode>     read-only, ask, or auto
  --allow-network           enable public web search and fetch tools
  --trust-workspace         treat workspace .pulse/config.json as user-trusted
  --system-prompt <text>    custom system instructions
  --system-prompt-file <path> load custom system instructions from file
  --mock-response <text>    deterministic response for local debugging
  --live                    doctor: make one real provider request
  --no-color                disable terminal styling
  --help, -h                show this help
  --version, -v             show the version
  setup --force              write a user config template (also created on first run)
`

export interface Parsed {
  command: string
  positionals: string[]
  options: Record<string, string | boolean>
}

export function parse(argv: string[]): Parsed {
  const options: Record<string, string | boolean> = {}
  const positionals: string[] = []
  let command = ''
  const forwarded = argv[0] === '--' ? argv.slice(1) : argv

  for (let index = 0; index < forwarded.length; index++) {
    const arg = forwarded[index]
    if (!arg) continue
    if (arg === '--') {
      positionals.push(...forwarded.slice(index + 1))
      break
    }
    if (arg.startsWith('--')) {
      const parts = arg.slice(2).split('=', 2)
      const key = parts[0] ?? ''
      const inline = parts[1]
      if (!key) continue
      if (inline !== undefined) {
        options[key] = inline
        continue
      }
      const next = forwarded[index + 1]
      if (next && !next.startsWith('-')) {
        options[key] = next
        index++
      } else {
        options[key] = true
      }
      continue
    }
    if (arg.startsWith('-') && arg.length === 2) {
      const key = arg === '-h' ? 'help' : arg === '-v' ? 'version' : arg.slice(1)
      options[key] = true
      continue
    }
    if (!command && ['run', 'sessions', 'resume', 'doctor', 'setup'].includes(arg)) {
      command = arg
    } else {
      positionals.push(arg)
    }
  }
  return { command, positionals, options }
}

export function option(options: Parsed['options'], key: string): string | undefined {
  const value = options[key]
  return typeof value === 'string' ? value : undefined
}

export async function hostOptions(parsed: Parsed): Promise<LocalHostOptions> {
  const requestedCwd = expandHome(option(parsed.options, 'cwd'))
  const explicitConfig = expandHome(option(parsed.options, 'config'))
  if (explicitConfig === undefined && process.env.PULSE_CONFIG === undefined) {
    await ensurePulseUserConfig()
  }
  const config = (
    await loadPulseConfig(requestedCwd ?? process.cwd(), explicitConfig, parsed.options['trust-workspace'] === true)
  ).value

  const requestedModel = option(parsed.options, 'model') ?? process.env.PULSE_MODEL ?? config.activeModel
  const configuredModelEntry = requestedModel === undefined
    ? undefined
    : Object.entries(config.models ?? {}).find(([name, item]) => name === requestedModel || item.displayName === requestedModel)
  if (!configuredModelEntry) throw new Error(`UNKNOWN_MODEL_DISPLAY_NAME:${requestedModel ?? '(missing)'}`)
  const [, modelSelection] = configuredModelEntry
  const activeModelName = modelSelection.displayName
  const providerName = modelSelection.provider
  const profile = config.providers?.[providerName]
  if (!profile) throw new Error(`MODEL_PROVIDER_NOT_FOUND:${providerName}`)
  const model = modelSelection.modelCode
  const baseURL = profile.baseURL
  const contextTokens = option(parsed.options, 'context-tokens') ?? process.env.PULSE_CONTEXT_TOKENS
  const maxOutputTokens = option(parsed.options, 'max-output-tokens') ?? process.env.PULSE_MAX_OUTPUT_TOKENS
  const reasoningEffort = option(parsed.options, 'reasoning-effort') ?? process.env.PULSE_REASONING_EFFORT
  const maxTurns = option(parsed.options, 'max-turns') ?? process.env.PULSE_MAX_TURNS
  const autoCompactPercent = option(parsed.options, 'auto-compact-percent') ?? process.env.PULSE_AUTO_COMPACT_PERCENT
  const apiKeyEnv = profile.apiKeyEnv ?? (profile.provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
  const apiKey = process.env[apiKeyEnv]
  const parsePositiveInteger = (value: string | undefined): number | undefined => {
    if (value === undefined) return undefined
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  const configuredContextTokens = parsePositiveInteger(contextTokens) ?? modelSelection.maxContextTokens ?? profile.maxContextTokens
  const configuredMaxOutputTokens = parsePositiveInteger(maxOutputTokens) ?? modelSelection.maxOutputTokens ?? profile.maxOutputTokens
  const configuredReasoningEffort = reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high' ? reasoningEffort : modelSelection.reasoningEffort ?? profile.reasoningEffort
  const configuredToolChoice = profile.toolChoice
  const configuredMaxTurns = parsePositiveInteger(maxTurns) ?? config.maxTurns
  const configuredAutoCompactPercent = parsePositiveInteger(autoCompactPercent) ?? config.autoCompactPercent
  const provider = {
    provider: profile.provider,
    defaultModel: model,
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(configuredContextTokens === undefined ? {} : { maxContextTokens: configuredContextTokens }),
    ...(configuredMaxOutputTokens === undefined ? {} : { maxOutputTokens: configuredMaxOutputTokens }),
    ...(configuredReasoningEffort === undefined ? {} : { reasoningEffort: configuredReasoningEffort }),
    ...(configuredToolChoice === undefined ? {} : { toolChoice: configuredToolChoice }),
  }
  const providerProfiles = Object.fromEntries(Object.entries(config.providers ?? {}).flatMap(([name, item]: [string, PulseCliProviderProfile]) => {
    if (!item.provider) throw new Error(`PROVIDER_PROTOCOL_REQUIRED:${name}`)
    const adapterProvider = item.provider
    const itemKeyEnv = item.apiKeyEnv ?? (adapterProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
    const itemKey = process.env[itemKeyEnv]
    return [[name, {
      provider: adapterProvider,
      ...(item.baseURL === undefined ? {} : { baseURL: item.baseURL }),
      ...(itemKey === undefined ? {} : { apiKey: itemKey }),
      ...(item.maxContextTokens === undefined ? {} : { maxContextTokens: item.maxContextTokens }),
      ...(item.maxOutputTokens === undefined ? {} : { maxOutputTokens: item.maxOutputTokens }),
      ...(item.reasoningEffort === undefined ? {} : { reasoningEffort: item.reasoningEffort }),
      ...(item.toolChoice === undefined ? {} : { toolChoice: item.toolChoice }),
    }]]
  }))
  const modelDisplayNames = new Set<string>()
  const providerModels = Object.fromEntries(Object.entries(config.models ?? {}).flatMap(([name, item]: [string, PulseCliModel]) => {
    if (!config.providers?.[item.provider]) throw new Error(`MODEL_PROVIDER_NOT_FOUND:${item.provider}`)
    const displayName = item.displayName.trim()
    if (!displayName) throw new Error(`MODEL_DISPLAY_NAME_REQUIRED:${name}`)
    if (modelDisplayNames.has(displayName)) throw new Error(`DUPLICATE_MODEL_DISPLAY_NAME:${displayName}`)
    modelDisplayNames.add(displayName)
    return [[displayName, { provider: item.provider, model: item.modelCode }]]
  }))
  const cwd = requestedCwd ?? expandHome(config.cwd)
  const dataDir = expandHome(option(parsed.options, 'data-dir') ?? process.env.PULSE_DATA_DIR ?? config.dataDir)
  const mockResponse = option(parsed.options, 'mock-response')
  const requestedApprovalMode = option(parsed.options, 'approval-mode') ?? process.env.PULSE_APPROVAL_MODE
  const approvalMode =
    requestedApprovalMode === 'read-only' || parsed.options['read-only'] === true
      ? ('read-only' as const)
      : requestedApprovalMode === 'auto' || parsed.options['auto-approve'] === true || process.env.PULSE_AUTO_APPROVE === '1'
        ? ('auto' as const)
        : requestedApprovalMode === 'ask' ? ('ask' as const) : config.approvalMode
  const allowNetwork =
    parsed.options['allow-network'] === true || process.env.PULSE_ALLOW_NETWORK === '1' ? true : config.allowNetwork

  const rawSystemPrompt = option(parsed.options, 'system-prompt') ?? process.env.PULSE_SYSTEM_PROMPT ?? config.systemPrompt
  const rawSystemPromptFile = option(parsed.options, 'system-prompt-file') ?? process.env.PULSE_SYSTEM_PROMPT_FILE ?? config.systemPromptFile
  let systemPrompt = rawSystemPrompt
  if (rawSystemPromptFile) {
    const expanded = expandHome(rawSystemPromptFile)
    const filePath = expanded ? resolve(requestedCwd ?? process.cwd(), expanded) : undefined
    if (filePath) {
      try {
        const fileContent = await readFile(filePath, 'utf8')
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${fileContent.trim()}` : fileContent.trim()
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error(`SYSTEM_PROMPT_FILE_NOT_FOUND: ${filePath}`)
        }
        throw error
      }
    }
  }

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(systemPrompt && systemPrompt.trim().length > 0 ? { systemPrompt: systemPrompt.trim() } : {}),
    provider,
    providerProfiles,
    providerModels,
    activeProviderCode: providerName,
    activeModel: activeModelName,
    ...(mockResponse === undefined ? {} : { mockResponse }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(configuredMaxTurns === undefined ? {} : { maxTurns: configuredMaxTurns }),
    ...(configuredAutoCompactPercent === undefined ? {} : { autoCompactPercent: Math.min(90, configuredAutoCompactPercent) }),
    ...(allowNetwork === undefined ? {} : { allowNetwork }),
  }
}

export async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2))
  if (parsed.options.help || parsed.options.h) {
    process.stdout.write(help)
    return 0
  }
  if (parsed.options.version || parsed.options.v) {
    process.stdout.write(`${version}\n`)
    return 0
  }

  if (parsed.command === 'setup') {
    return runSetup(parsed.options.force === true, expandHome(option(parsed.options, 'config')))
  }

  const options = await hostOptions(parsed)

  if (parsed.command === 'doctor') {
    return runDoctor(options, parsed.options.live === true, option(parsed.options, 'format') ?? 'text')
  }

  if (parsed.command === 'sessions') {
    return runSessions(options, option(parsed.options, 'format') ?? 'text', version)
  }

  if (parsed.command === 'run') {
    const task = parsed.positionals.join(' ').trim()
    if (!task) throw new Error('TASK_REQUIRED')
    return runOneShot(options, task, option(parsed.options, 'format') ?? 'text', version)
  }

  if (parsed.command === 'resume') {
    const id = parsed.positionals.shift()
    const task = parsed.positionals.join(' ').trim()
    if (!id) throw new Error('RESUME_REQUIRES_ID')
    return runResume(options, id, task || undefined, option(parsed.options, 'format') ?? 'text', version)
  }

  // 默认启动交互式 Ink 界面
  return runInteractive(options, undefined, undefined, version, parsed.options.resume === true)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
