#!/usr/bin/env node
import { createRequire } from 'node:module'
import type { LocalHostOptions } from '@hunterzhu/pulse-server'
import { ensurePulseUserConfig, expandHome, loadPulseConfig } from './config.js'
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
  pulse run <task> [options]              run one task
  pulse sessions [options]                list saved conversations
  pulse resume <conversation-id> [task]    continue or recover a conversation
  pulse doctor [options]                  check local configuration

Options:
  --cwd <path>              workspace directory
  --data-dir <path>         Pulse data directory
  --config <path>           user configuration file (default home/.pulse/config.json)
  --provider <name>         mock, openai-compatible, or anthropic
  --model <name>            provider model name
  --base-url <url>          provider endpoint
  --format <text|jsonl>     output format
  --read-only               disable write and shell tools
  --auto-approve             allow local writes and shell execution
  --allow-network           enable public web search and fetch tools
  --trust-workspace         treat workspace .pulse/config.json as user-trusted
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

  const providerName = option(parsed.options, 'provider') ?? process.env.PULSE_PROVIDER ?? config.provider?.provider
  const model = option(parsed.options, 'model') ?? process.env.PULSE_MODEL ?? config.provider?.model
  const baseURL = option(parsed.options, 'base-url') ?? process.env.PULSE_BASE_URL ?? config.provider?.baseURL
  const apiKeyEnv =
    config.provider?.apiKeyEnv ?? (providerName === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY')
  const apiKey = process.env[apiKeyEnv]
  const provider = providerName
    ? {
        provider: providerName,
        ...(model === undefined ? {} : { defaultModel: model }),
        ...(baseURL === undefined ? {} : { baseURL }),
        ...(apiKey === undefined ? {} : { apiKey }),
      }
    : undefined
  const cwd = requestedCwd ?? expandHome(config.cwd)
  const dataDir = expandHome(option(parsed.options, 'data-dir') ?? process.env.PULSE_DATA_DIR ?? config.dataDir)
  const mockResponse = option(parsed.options, 'mock-response')
  const approvalMode =
    parsed.options['read-only'] === true
      ? ('read-only' as const)
      : parsed.options['auto-approve'] === true || process.env.PULSE_AUTO_APPROVE === '1'
        ? ('auto' as const)
        : config.approvalMode
  const allowNetwork =
    parsed.options['allow-network'] === true || process.env.PULSE_ALLOW_NETWORK === '1' ? true : config.allowNetwork

  return {
    ...(cwd === undefined ? {} : { cwd }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(provider === undefined ? {} : { provider }),
    ...(mockResponse === undefined ? {} : { mockResponse }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(allowNetwork === undefined ? {} : { allowNetwork }),
  }
}

async function main(): Promise<number> {
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
  return runInteractive(options, undefined, undefined, version)
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
