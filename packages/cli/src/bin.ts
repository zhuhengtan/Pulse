#!/usr/bin/env node
import { createInterface } from 'node:readline'
import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
import { createLocalHost, type AssistantEvent, type LocalHostOptions, type RunHandle } from '@hunterzhu/pulse-server'
import { defaultPulseConfig, defaultPulseConfigPath, ensurePulseUserConfig, expandHome, loadPulseConfig } from './config.js'

const packageManifest = createRequire(import.meta.url)('../package.json') as { version: string }
const version = packageManifest.version
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

interface Parsed { command: string; positionals: string[]; options: Record<string, string | boolean> }
function parse(argv: string[]): Parsed {
  const options: Record<string, string | boolean> = {}; const positionals: string[] = []; let command = ''; const forwarded = argv[0] === '--' ? argv.slice(1) : argv
  for (let index = 0; index < forwarded.length; index++) { const arg = forwarded[index]; if (!arg) continue; if (arg === '--') { positionals.push(...forwarded.slice(index + 1)); break } if (arg.startsWith('--')) { const parts = arg.slice(2).split('=', 2); const key = parts[0] ?? ''; const inline = parts[1]; if (!key) continue; if (inline !== undefined) { options[key] = inline; continue } const next = forwarded[index + 1]; if (next && !next.startsWith('-')) { options[key] = next; index++ } else options[key] = true; continue } if (arg.startsWith('-') && arg.length === 2) { const key = arg === '-h' ? 'help' : arg === '-v' ? 'version' : arg.slice(1); options[key] = true; continue } if (!command && ['run', 'sessions', 'resume', 'doctor', 'setup'].includes(arg)) command = arg; else positionals.push(arg) }
  return { command, positionals, options }
}
function option(options: Parsed['options'], key: string): string | undefined { const value = options[key]; return typeof value === 'string' ? value : undefined }
async function hostOptions(parsed: Parsed): Promise<LocalHostOptions> { const requestedCwd = expandHome(option(parsed.options, 'cwd')); const explicitConfig = expandHome(option(parsed.options, 'config')); if (explicitConfig === undefined && process.env.PULSE_CONFIG === undefined) await ensurePulseUserConfig(); const config = (await loadPulseConfig(requestedCwd ?? process.cwd(), explicitConfig, parsed.options['trust-workspace'] === true)).value; const providerName = option(parsed.options, 'provider') ?? process.env.PULSE_PROVIDER ?? config.provider?.provider; const model = option(parsed.options, 'model') ?? process.env.PULSE_MODEL ?? config.provider?.model; const baseURL = option(parsed.options, 'base-url') ?? process.env.PULSE_BASE_URL ?? config.provider?.baseURL; const apiKeyEnv = config.provider?.apiKeyEnv ?? (providerName === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'); const apiKey = process.env[apiKeyEnv]; const provider = providerName ? { provider: providerName, ...(model === undefined ? {} : { defaultModel: model }), ...(baseURL === undefined ? {} : { baseURL }), ...(apiKey === undefined ? {} : { apiKey }) } : undefined; const cwd = requestedCwd ?? expandHome(config.cwd); const dataDir = expandHome(option(parsed.options, 'data-dir') ?? process.env.PULSE_DATA_DIR ?? config.dataDir); const mockResponse = option(parsed.options, 'mock-response'); const approvalMode = parsed.options['read-only'] === true ? 'read-only' as const : parsed.options['auto-approve'] === true || process.env.PULSE_AUTO_APPROVE === '1' ? 'auto' as const : config.approvalMode; const allowNetwork = parsed.options['allow-network'] === true || process.env.PULSE_ALLOW_NETWORK === '1' ? true : config.allowNetwork; return { ...(cwd === undefined ? {} : { cwd }), ...(dataDir === undefined ? {} : { dataDir }), ...(provider === undefined ? {} : { provider }), ...(mockResponse === undefined ? {} : { mockResponse }), ...(approvalMode === undefined ? {} : { approvalMode }), ...(allowNetwork === undefined ? {} : { allowNetwork }) } }
async function setupConfig(force: boolean, explicitPath?: string): Promise<void> { const path = explicitPath ?? process.env.PULSE_CONFIG ?? defaultPulseConfigPath(); try { await access(path); if (!force) throw new Error(`CONFIG_EXISTS:${path}`) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && error instanceof Error && error.message.startsWith('CONFIG_EXISTS:')) throw error } await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(defaultPulseConfig, null, 2)}\n`, { mode: 0o600 }); await chmod(path, 0o600); process.stdout.write(`Wrote ${path}\n`) }
function writeEvent(event: AssistantEvent, format: string): void { if (format === 'jsonl') { process.stdout.write(`${JSON.stringify(event)}\n`); return } if (event.type === 'text') process.stdout.write(String(event.data ?? '')); else if (event.type === 'waiting') process.stdout.write(`\n[需要输入] ${JSON.stringify(event.data ?? '')}\n`); else if (event.type === 'error') process.stderr.write(`\n[错误] ${String(event.data ?? '')}\n`) }
async function consume(run: RunHandle, format: string, approvalInput?: ReturnType<typeof createInterface>): Promise<{ status: string }> { let streamedText = false; let ownedApprovalInput = false; let input = approvalInput; try { for await (const event of run.events) { if (event.type === 'text') streamedText = true; writeEvent(event, format); if (event.type === 'waiting') { const payload = event.data && typeof event.data === 'object' && !Array.isArray(event.data) ? event.data as Record<string, unknown> : {}; const effectId = typeof payload.effectId === 'string' ? payload.effectId : undefined; const request = payload.input && typeof payload.input === 'object' && !Array.isArray(payload.input) ? payload.input as Record<string, unknown> : {}; if (!effectId) { await run.cancel('INVALID_APPROVAL_REQUEST'); continue } if (!process.stdin.isTTY) { await run.cancel('INTERACTION_REQUIRED'); continue } if (!input) { input = createInterface({ input: process.stdin, output: process.stderr, terminal: true }); ownedApprovalInput = true } const prompt = typeof request.prompt === 'string' ? request.prompt : 'Approve this operation?'; const answer = await new Promise<string>((resolve) => input!.question(`${prompt}\nApprove? [y/N] `, resolve)); const approved = ['y', 'yes', '是', '确认'].includes(answer.trim().toLocaleLowerCase()); await run.reply(effectId, { approved, ...(approved ? {} : { reason: answer.trim() || 'User denied the operation.' }) }); } } const outcome = await run.outcome(); if (format === 'jsonl') { process.stdout.write(`${JSON.stringify({ schemaVersion: 1, type: 'result', runId: run.id, status: outcome.status, text: outcome.text ?? null })}\n`); } else if (!streamedText && outcome.text) process.stdout.write(`${outcome.text}\n`); else process.stdout.write(`\n[${outcome.status}]\n`); return outcome } finally { if (ownedApprovalInput) input?.close() } }
async function consumeManaged(run: RunHandle, format: string, approvalInput: ReturnType<typeof createInterface> | undefined, setActive: (run: RunHandle | undefined) => void): Promise<{ status: string }> { setActive(run); try { return await consume(run, format, approvalInput) } finally { setActive(undefined) } }
async function interactive(host: ReturnType<typeof createLocalHost>, conversationId: string | undefined, setActive: (run: RunHandle | undefined) => void): Promise<void> {
  const conversation = conversationId ? await host.getConversation(conversationId) : await host.createConversation();
  process.stderr.write(`Pulse · ${conversation.summary.cwd}\nType /help for commands.\n`)
  const input = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
  input.setPrompt('› ')
  const prompt = (): void => { if (input.terminal) input.prompt() }
  prompt()
  for await (const line of input) {
    const text = line.trim()
    if (!text) { prompt(); continue }
    if (text === '/exit' || text === '/quit') break
    if (text === '/help') { process.stderr.write('Commands: /help /status /tools /artifacts /exit\n'); prompt(); continue }
    if (text === '/status') { process.stderr.write(`${JSON.stringify(conversation.summary)}\n`); prompt(); continue }
    if (text === '/tools') { process.stderr.write(`${(await host.doctor()).tools.join(', ')}\n`); prompt(); continue }
    if (text === '/artifacts') { process.stderr.write(`${JSON.stringify(await host.listArtifacts(conversation.id), null, 2)}\n`); prompt(); continue }
    if (text === '/new') { process.stderr.write('Start another `npx @hunterzhu/pulse-cli` process for a new conversation.\n'); prompt(); continue }
    try { const run = await host.sendMessage(conversation.id, { text }); await consumeManaged(run, 'text', input, setActive) } catch (error) { process.stderr.write(`[错误] ${error instanceof Error ? error.message : String(error)}\n`) }
    prompt()
  }
  input.close()
}
async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2)); if (parsed.options.help || parsed.options.h) { process.stdout.write(help); return 0 } if (parsed.options.version || parsed.options.v) { process.stdout.write(`${version}\n`); return 0 }
  if (parsed.command === 'setup') { await setupConfig(parsed.options.force === true, expandHome(option(parsed.options, 'config'))); process.stdout.write('Configure the provider in that file, then run `pulse doctor`.\n'); return 0 }
  const host = createLocalHost(await hostOptions(parsed)); await host.init(); let activeRun: RunHandle | undefined; const onInterrupt = (): void => { if (activeRun) { void activeRun.cancel('USER_INTERRUPT') } else process.exitCode = 130 }; process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt)
  try {
    if (parsed.command === 'doctor') { const result = await host.doctor({ live: parsed.options.live === true }); process.stdout.write(parsed.options.format === 'jsonl' ? `${JSON.stringify(result)}\n` : `${result.ok ? 'ok' : 'error'}\nworkspace: ${result.cwd}\ndata: ${result.dataDir}\nnode: ${result.node}\nprovider: ${result.provider}\ntools: ${result.tools.join(', ')}\n${result.live ? `live: ${result.live.ok ? 'ok' : 'error'} (${result.live.message})\n` : ''}${result.errors.map((item) => `error: ${item}`).join('\n')}`.trim() + '\n'); return result.ok ? 0 : 1 }
    if (parsed.command === 'sessions') { const sessions = await host.listConversations(); process.stdout.write(parsed.options.format === 'jsonl' ? sessions.map((item) => `${JSON.stringify(item)}\n`).join('') : (sessions.length ? sessions.map((item) => `${item.id}\t${item.updatedAt}\t${item.title}\t${item.cwd}`).join('\n') + '\n' : 'No conversations.\n')); return 0 }
    if (parsed.command === 'run') { const task = parsed.positionals.join(' ').trim(); if (!task) throw new Error('TASK_REQUIRED'); const cwd = option(parsed.options, 'cwd'); const conversation = await host.createConversation(cwd === undefined ? {} : { cwd }); const outcome = await consumeManaged(await host.sendMessage(conversation.id, { text: task, format: option(parsed.options, 'format') === 'jsonl' ? 'jsonl' : 'text' }), option(parsed.options, 'format') ?? 'text', undefined, (run) => { activeRun = run }); return outcome.status === 'succeeded' ? 0 : outcome.status === 'cancelled' ? 3 : 1 }
    if (parsed.command === 'resume') { const id = parsed.positionals.shift(); const task = parsed.positionals.join(' ').trim(); if (!id) throw new Error('RESUME_REQUIRES_ID'); const run = task ? await host.sendMessage(id, { text: task }) : await host.resumeRun(id); const outcome = await consumeManaged(run, option(parsed.options, 'format') ?? 'text', undefined, (current) => { activeRun = current }); return outcome.status === 'succeeded' ? 0 : outcome.status === 'cancelled' ? 3 : 1 }
    await interactive(host, undefined, (run) => { activeRun = run }); return 0
  } finally { process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt); await host.close() }
}
main().then((code) => { process.exitCode = code }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1 })
