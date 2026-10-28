#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installProcessDiagnostics, createLocalHost, automationDoctor, requestAutomationPermissions, assertJarvisApiUrl, createBuiltinSkillCapabilityPack, createMcpCapabilityPack, createPdfCapabilityPack, createSkillCapabilityPack, createSpreadsheetCapabilityPack, type LocalHostOptions } from '@hunterzhu/pulse-server'
import { modelSelectionId, normalizeModelConfig, resolveModelReference, resolveProviderApiKey } from '@hunterzhu/pulse-server'
import { defaultPulseConfig, defaultPulseConfigPath, ensurePulseUserConfig, expandHome, loadPulseConfig, type PulseCliConfig, type PulseCliProviderProfile } from './config.js'
import { runInteractive } from './commands/interactive.js'
import { runOneShot } from './commands/run.js'
import { runDoctor } from './commands/doctor.js'
import { runSessions } from './commands/sessions.js'
import { runResume } from './commands/resume.js'
import { runSetup } from './commands/setup.js'
import { runScheduledCommand } from './commands/scheduled.js'
import { runServiceCommand } from './commands/service.js'
import { runTemplateCommand } from './commands/template.js'
import { runMcpDoctor } from './commands/mcp.js'
import { runH5Command } from './commands/h5.js'
import { runUpdateCommand } from './commands/update.js'
import { isSameModulePath } from './utils/is-main-module.js'
import { formatVersionOutput, shouldUseColor } from './presentation.js'

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
  pulse drafts <conversation-id> <run-id> <draft-id> [--revision <hash> --confirm-owner]\n                                          preview or explicitly migrate an ownerless draft\n  pulse doctor [options]                  check local configuration
  pulse h5 [start|qr|devices|revoke|install|status|stop|uninstall]
                                          mobile web assistant and launchd daemon
  pulse update [status|check|download|apply|rollback|enable|auto-download on|off]
                                          independent backend and frontend updates
  pulse schedule <add|list|pause|resume|remove|daemon> [options]
                                          manage recurring tasks (daemon requires read-only or auto approval)
  pulse service <install|status|start|stop|uninstall>
  pulse template <list|show|run> [name] [values...]
  pulse automation doctor                  check browser and desktop dependencies
  pulse mcp doctor [server-id]

Options:
  --cwd <path>              workspace directory
  --data-dir <path>         Pulse data directory
  --config <path>           user configuration file (default home/.pulse/config.json)
  --model <name>            Pulse model display name
  --context-tokens <n>      model context window (default 32000)
  --max-output-tokens <n>   maximum generated tokens (default 4096)
  --reasoning-effort <x>    low, medium, or high
  --max-turns <n>           maximum ReAct model/tool turns (default 32)
  --max-model-calls <n>     maximum model attempts per work task (default 256)
  --auto-compact-percent <n> compact automatically at this percent of the context window (1-90, default 90)
  --accept-build-migration <old:new> authorize one reviewed recovery build pair\n  --requirements-doc <path> explicitly attach a workspace requirements document\n  --format <text|jsonl>     output format
  --resume                  enter the latest saved session
  --read-only               disable write and shell tools
  --auto-approve             approve local writes and shell execution on your behalf
  --approval-mode <mode>     read-only, ask, or auto
  --allow-network           enable public web search and fetch tools
  --no-network              disable network tools even when user config enables them
  --trust-workspace         treat workspace .pulse/config.json as user-trusted
  --system-prompt <text>    custom system instructions
  --system-prompt-file <path> load custom system instructions from file
  --mock-response <text>    deterministic response for local debugging
  --mock-task-assessment <json> deterministic verifier result for local debugging
  --mock-stage-assessment <json> deterministic stage verifier results for local debugging
  --mock-parallel-plan <json> deterministic task or read-only split plan for local debugging
  --mock-tool-calls <json>  deterministic tool calls for local debugging
  --mock-after-tool-response <text> deterministic response after tool execution
  --task-controller         force the multi-stage task controller
  --no-task-controller      keep a single ReAct loop
  --jarvis                  enable Jarvis cognitive memory architecture
  --no-jarvis               disable Jarvis cognitive memory architecture
  --jarvis-url <url>        Jarvis API base URL (default http://127.0.0.1:7330)
  --jarvis-token <token>    bearer token for the Jarvis API
  --jarvis-budget <n>       context token budget sent to Jarvis (default 4000)
  --jarvis-allow-remote     allow a Jarvis URL that is not loopback
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

const knownBooleanFlags = new Set([
  'resume',
  'read-only',
  'auto-approve',
  'allow-network',
  'no-network',
  'trust-workspace',
  'task-controller',
  'no-task-controller',
  'live',
  'no-color',
  'help',
  'version',
  'force',
  'confirm-owner',
  'jarvis',
  'no-jarvis',
  'jarvis-allow-remote',
])

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
      const body = arg.slice(2)
      const equalsIndex = body.indexOf('=')
      const key = equalsIndex === -1 ? body : body.slice(0, equalsIndex)
      const inline = equalsIndex === -1 ? undefined : body.slice(equalsIndex + 1)
      if (!key) continue
      if (inline !== undefined) {
        options[key] = inline
        continue
      }
      if (knownBooleanFlags.has(key)) {
        options[key] = true
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
  if (!command && ['run', 'sessions', 'resume', 'doctor', 'setup', 'schedule', 'service', 'template', 'mcp', 'h5', 'update', 'automation', 'drafts'].includes(arg)) {
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
  const loadedConfig = await loadPulseConfig(requestedCwd ?? process.cwd(), explicitConfig, parsed.options['trust-workspace'] === true)
  const loaded = loadedConfig.value
  const credentialConfigPath = resolve(explicitConfig ?? expandHome(process.env.PULSE_CONFIG) ?? loadedConfig.source ?? defaultPulseConfigPath())
  // A missing user config still has to answer usage errors and list sessions.
  const config: PulseCliConfig = normalizeModelConfig(loaded.activeModel || loaded.models || loaded.providers ? loaded : { ...defaultPulseConfig, ...loaded })

  const mockResponse = option(parsed.options, 'mock-response')
  const mockTaskAssessment = option(parsed.options, 'mock-task-assessment')
  const mockStageAssessment = option(parsed.options, 'mock-stage-assessment')
  const mockToolCallsOption = option(parsed.options, 'mock-tool-calls')
  const mockAfterToolResponse = option(parsed.options, 'mock-after-tool-response')
  const mockParallelPlanOption = option(parsed.options, 'mock-parallel-plan')
  const hasMockDemand = mockResponse !== undefined || mockTaskAssessment !== undefined || mockStageAssessment !== undefined || mockToolCallsOption !== undefined || mockAfterToolResponse !== undefined || mockParallelPlanOption !== undefined

  const cliModel = option(parsed.options, 'model')
  const requestedModel = cliModel ?? (hasMockDemand ? 'mock/mock' : process.env.PULSE_MODEL ?? config.activeModel)

  const effectiveProviders: Record<string, PulseCliProviderProfile> = { ...(config.providers ?? {}) }

  if (requestedModel === 'mock/mock' || requestedModel === 'mock' || (hasMockDemand && cliModel === undefined)) {
    if (!effectiveProviders.mock) {
      effectiveProviders.mock = { provider: 'mock', name: 'Mock' }
    }
    effectiveProviders.mock.models ??= {}
    effectiveProviders.mock.models.mock ??= { displayName: 'mock', modelCode: 'mock', maxContextTokens: 32_000, maxOutputTokens: 4_096, reasoningEffort: 'medium' }
  }

  const catalog = { ...config, providers: effectiveProviders }
  const selections = Object.entries(effectiveProviders).flatMap(([providerId, profile]) => Object.entries(profile.models ?? {}).map(([modelId, model]) => ({ id: modelSelectionId(providerId, modelId), providerId, modelId, model })))
  if (!requestedModel) throw new Error('UNKNOWN_MODEL_DISPLAY_NAME:(missing)')
  let activeModelName: string
  try { activeModelName = resolveModelReference(catalog, requestedModel) }
  catch (error) { if (error instanceof Error && error.message.startsWith('AMBIGUOUS_MODEL_REFERENCE:')) throw error; throw new Error(`UNKNOWN_MODEL_DISPLAY_NAME:${requestedModel}`) }
  const configuredModelEntry = selections.find(item => item.id === activeModelName)
  if (!configuredModelEntry) throw new Error(`UNKNOWN_MODEL_DISPLAY_NAME:${requestedModel}`)
  const modelSelection = configuredModelEntry.model
  if (modelSelection.tools === 'unsupported') throw new Error('MODEL_AGENT_TOOLS_UNSUPPORTED')
  const providerName = configuredModelEntry.providerId
  const profile = effectiveProviders[providerName]
  if (!profile) throw new Error(`MODEL_PROVIDER_NOT_FOUND:${providerName}`)
  const model = modelSelection.modelCode
  if (modelSelection.pricing && (!/^[A-Z]{3}$/.test(modelSelection.pricing.currency) || !Number.isFinite(modelSelection.pricing.inputPerMillion) || modelSelection.pricing.inputPerMillion < 0 || !Number.isFinite(modelSelection.pricing.outputPerMillion) || modelSelection.pricing.outputPerMillion < 0 || !modelSelection.pricing.version.trim())) throw new Error(`INVALID_MODEL_PRICING:${activeModelName}`)
  const baseURL = profile.baseURL
  const contextTokens = option(parsed.options, 'context-tokens') ?? process.env.PULSE_CONTEXT_TOKENS
  const maxOutputTokens = option(parsed.options, 'max-output-tokens') ?? process.env.PULSE_MAX_OUTPUT_TOKENS
  const reasoningEffort = option(parsed.options, 'reasoning-effort') ?? process.env.PULSE_REASONING_EFFORT
  const maxTurns = option(parsed.options, 'max-turns') ?? process.env.PULSE_MAX_TURNS
  const maxModelCalls = option(parsed.options, 'max-model-calls') ?? process.env.PULSE_MAX_MODEL_CALLS
  const maxRuntimeMs = option(parsed.options, 'max-runtime-ms') ?? process.env.PULSE_MAX_RUNTIME_MS
  const autoCompactPercent = option(parsed.options, 'auto-compact-percent') ?? process.env.PULSE_AUTO_COMPACT_PERCENT
  const resolvedKeys = Object.fromEntries(await Promise.all(Object.entries(effectiveProviders).map(async ([id, source]) => [id, await resolveProviderApiKey(source, credentialConfigPath)] as const)))
  const apiKey = resolvedKeys[providerName]
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
  const configuredMaxModelCalls = parsePositiveInteger(maxModelCalls) ?? config.maxModelCalls ?? 256
  const configuredMaxRuntimeMs = parsePositiveInteger(maxRuntimeMs) ?? config.maxRuntimeMs
  const configuredAutoCompactPercent = parsePositiveInteger(autoCompactPercent) ?? config.autoCompactPercent
  const provider = {
    provider: profile.provider,
    defaultModel: model,
    ...(modelSelection.remote === true ? { remote: true } : {}),
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(configuredContextTokens === undefined ? {} : { maxContextTokens: configuredContextTokens }),
    ...(configuredMaxOutputTokens === undefined ? {} : { maxOutputTokens: configuredMaxOutputTokens }),
    ...(configuredReasoningEffort === undefined ? {} : { reasoningEffort: configuredReasoningEffort }),
    ...(configuredToolChoice === undefined ? {} : { toolChoice: configuredToolChoice }),
  }
  const providerProfiles = Object.fromEntries(Object.entries(effectiveProviders).flatMap(([name, item]: [string, PulseCliProviderProfile]) => {
    if (!item.provider) throw new Error(`PROVIDER_PROTOCOL_REQUIRED:${name}`)
    const adapterProvider = item.provider
    const itemKey = resolvedKeys[name]
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
  for (const selection of selections) if (selection.model.imageInput !== undefined && !['supported','unsupported','unknown'].includes(selection.model.imageInput)) throw new Error(`INVALID_MODEL_IMAGE_INPUT:${selection.id}`)
  const providerModels: NonNullable<LocalHostOptions['providerModels']> = Object.fromEntries(selections.map(({ id, providerId, model }) => [id, {
      provider: providerId,
      model: model.modelCode,
      ...(model.remote === true ? { remote: true } : {}),
      ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }),
      ...(model.tools === undefined ? {} : { tools: model.tools }),
      ...(model.structuredOutput === undefined ? {} : { structuredOutput: model.structuredOutput }),
      ...(model.maxContextTokens === undefined ? {} : { maxContextTokens: model.maxContextTokens }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(model.reasoningEffort === undefined ? {} : { reasoningEffort: model.reasoningEffort }),
    }]))
  // Explicit CLI/env limits must reach the routed candidate too. Otherwise the
  // model catalog silently overrides the adapter's smaller output/effort limits.
  const activeCandidate = providerModels[activeModelName]!
  if (parsePositiveInteger(contextTokens) !== undefined) activeCandidate.maxContextTokens = configuredContextTokens!
  if (parsePositiveInteger(maxOutputTokens) !== undefined) activeCandidate.maxOutputTokens = configuredMaxOutputTokens!
  if (reasoningEffort === 'low' || reasoningEffort === 'medium' || reasoningEffort === 'high') activeCandidate.reasoningEffort = reasoningEffort
  const assistantModelName = config.assistantModel ? resolveModelReference(catalog, config.assistantModel) : activeModelName
  if (!providerModels[assistantModelName]) throw new Error(`UNKNOWN_ASSISTANT_MODEL:${assistantModelName}`)
  const taskRouting = config.taskRouting && Object.fromEntries(Object.entries(config.taskRouting).map(([task, route]) => [task, Array.isArray(route) ? route.map(item => resolveModelReference(catalog, item)) : route])) as PulseCliConfig['taskRouting']
  for (const [task, models] of Object.entries(taskRouting ?? {})) {
    if (Array.isArray(models) && models.some(model => selections.find(item => item.id === model)?.model.tools === 'unsupported')) throw new Error('MODEL_AGENT_TOOLS_UNSUPPORTED')
    if (!Array.isArray(models) || models.length === 0 || models.some((model) => typeof model !== 'string' || !providerModels[model])) {
      throw new Error(`INVALID_TASK_MODEL_ROUTE:${task}`)
    }
    if (new Set(models).size !== models.length) throw new Error(`DUPLICATE_TASK_MODEL_ROUTE_CANDIDATE:${task}`)
  }
  const cwd = requestedCwd ?? expandHome(config.cwd)
  const dataDir = expandHome(option(parsed.options, 'data-dir') ?? process.env.PULSE_DATA_DIR ?? config.dataDir)
  let mockTaskAssessments: LocalHostOptions['mockTaskAssessments'] | undefined
  if (mockTaskAssessment !== undefined) {
    try {
      const value = JSON.parse(mockTaskAssessment) as unknown
      if (!Array.isArray(value) || value.length === 0 || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('INVALID')
      mockTaskAssessments = value as NonNullable<LocalHostOptions['mockTaskAssessments']>
    } catch {
      throw new Error('INVALID_MOCK_TASK_ASSESSMENT: expected a non-empty JSON array of assessment objects')
    }
  } else if (hasMockDemand) {
    mockTaskAssessments = [{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['AUTO'], rationale: 'Accepted by mock verifier.' }] }]
  }
  let mockStageAssessments: LocalHostOptions['mockStageAssessments'] | undefined
  if (mockStageAssessment !== undefined) {
    try {
      const value = JSON.parse(mockStageAssessment) as unknown
      if (!Array.isArray(value) || value.length === 0 || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('INVALID')
      mockStageAssessments = value as NonNullable<LocalHostOptions['mockStageAssessments']>
    } catch {
      throw new Error('INVALID_MOCK_STAGE_ASSESSMENT: expected a non-empty JSON array of stage assessment objects')
    }
  }
  let mockToolCalls: LocalHostOptions['mockToolCalls'] | undefined
  if (mockToolCallsOption !== undefined) {
    try {
      const value = JSON.parse(mockToolCallsOption) as unknown
      if (!Array.isArray(value) || value.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('INVALID')
      mockToolCalls = value as NonNullable<LocalHostOptions['mockToolCalls']>
    } catch {
      throw new Error('INVALID_MOCK_TOOL_CALLS: expected a JSON array of tool call objects')
    }
  }
  let mockParallelPlan: LocalHostOptions['mockParallelPlan'] | undefined
  if (mockParallelPlanOption !== undefined) {
    try {
      const value = JSON.parse(mockParallelPlanOption) as unknown
      if (!value || typeof value !== 'object') throw new Error('INVALID')
      mockParallelPlan = value as NonNullable<LocalHostOptions['mockParallelPlan']>
    } catch {
      throw new Error('INVALID_MOCK_PARALLEL_PLAN: expected a JSON object')
    }
  }
  const requestedApprovalMode = option(parsed.options, 'approval-mode') ?? process.env.PULSE_APPROVAL_MODE
  const approvalMode =
    requestedApprovalMode === 'read-only' || parsed.options['read-only'] === true
      ? ('read-only' as const)
      : requestedApprovalMode === 'auto' || parsed.options['auto-approve'] === true || process.env.PULSE_AUTO_APPROVE === '1'
        ? ('auto' as const)
        : requestedApprovalMode === 'ask' ? ('ask' as const) : config.approvalMode
  const allowNetwork = parsed.options['no-network'] === true ? false : parsed.options['allow-network'] === true || process.env.PULSE_ALLOW_NETWORK === '1' ? true : config.allowNetwork

  const capabilitySettings = config.capabilities ?? {}
  const skillRoots = capabilitySettings.trustedSkillRoots ?? []
  if (!Array.isArray(skillRoots) || skillRoots.some((root) => typeof root !== 'string' || !isAbsolute(expandHome(root) ?? root))) throw new Error('SKILL_TRUSTED_ROOT_MUST_BE_ABSOLUTE')
  const configuredCapabilityPacks = capabilitySettings.enabled ?? []
  if (!Array.isArray(configuredCapabilityPacks) || configuredCapabilityPacks.some((id) => typeof id !== 'string') || new Set(configuredCapabilityPacks).size !== configuredCapabilityPacks.length) throw new Error('INVALID_ENABLED_CAPABILITY_LIST')
  // Built-in skills are always enabled so they are discoverable with no external skills directory.
  const enabledCapabilityPacks = ['builtin-skills', ...configuredCapabilityPacks.filter((id) => id !== 'builtin-skills')]
  const skillNames = capabilitySettings.skills ?? []
  if (!Array.isArray(skillNames) || skillNames.some((name) => typeof name !== 'string')) throw new Error('INVALID_SKILL_SELECTION')
  const capabilityPacks = [createBuiltinSkillCapabilityPack(), createPdfCapabilityPack(), createSpreadsheetCapabilityPack(), createSkillCapabilityPack({ trustedRoots: skillRoots.map((root) => resolve(expandHome(root) ?? root)) })]
  for (const [id, server] of Object.entries(capabilitySettings.mcpServers ?? {})) {
    if ((id === 'browser' && capabilitySettings.browser) || (id === 'computer' && capabilitySettings.computer)) throw new Error(`AUTOMATION_CAPABILITY_CONFLICT:${id}`)
    if (!server || typeof server.command !== 'string' || server.command.trim().length === 0 || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== 'string')))) throw new Error(`INVALID_MCP_SERVER_CONFIG:${id}`)
    if (server.toolPolicies && Object.entries(server.toolPolicies).some(([name, policy]) => !name || !['read', 'write', 'external'].includes(policy))) throw new Error(`INVALID_MCP_TOOL_POLICY:${id}`)
    const resolvedEnv: Record<string, string> = { ...(server.env ?? {}) }
    for (const [childName, sourceName] of Object.entries(server.envFrom ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/i.test(childName) || !/^[A-Z_][A-Z0-9_]*$/i.test(sourceName)) throw new Error(`INVALID_MCP_ENV_REFERENCE:${id}`)
      const value = process.env[sourceName]
      if (value === undefined) throw new Error(`MCP_ENVIRONMENT_REQUIRED:${id}:${sourceName}`)
      resolvedEnv[childName] = value
    }
    capabilityPacks.push(createMcpCapabilityPack(id, {
      command: server.command,
      args: server.args ?? [],
      ...(server.cwd === undefined ? {} : { cwd: resolve(expandHome(server.cwd) ?? server.cwd) }),
      ...(Object.keys(resolvedEnv).length === 0 ? {} : { env: resolvedEnv }),
      ...(server.timeoutMs === undefined ? {} : { timeoutMs: server.timeoutMs }),
      ...(server.toolPolicies === undefined ? {} : { toolPolicies: server.toolPolicies }),
    }))
  }
  for (const id of enabledCapabilityPacks) {
    if (!['browser', 'computer'].includes(id) && !capabilityPacks.some((pack) => pack.manifest.id === id)) throw new Error(`UNKNOWN_ENABLED_CAPABILITY:${id}`)
  }

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

  const explicitTaskController = parsed.options['task-controller'] === true ? true : parsed.options['no-task-controller'] === true ? false : mockParallelPlanOption !== undefined ? true : undefined

  const explicitJarvis = parsed.options['jarvis'] === true
    ? true
    : parsed.options['no-jarvis'] === true
      ? false
      : process.env.PULSE_JARVIS_ENABLED !== undefined
        ? process.env.PULSE_JARVIS_ENABLED === '1' || process.env.PULSE_JARVIS_ENABLED.toLowerCase() === 'true'
        : config.jarvis?.enabled
  const jarvisUrl = option(parsed.options, 'jarvis-url') ?? process.env.PULSE_JARVIS_API_URL ?? config.jarvis?.apiUrl
  const jarvisToken = option(parsed.options, 'jarvis-token') ?? process.env.PULSE_JARVIS_TOKEN ?? config.jarvis?.token
  const jarvisBudget = parsePositiveInteger(option(parsed.options, 'jarvis-budget') ?? process.env.PULSE_JARVIS_BUDGET) ?? config.jarvis?.contextTokenBudget
  const jarvisAutoCandidate = config.jarvis?.autoCandidate ?? true
  const jarvisAllowRemote = parsed.options['jarvis-allow-remote'] === true
    || process.env.PULSE_JARVIS_ALLOW_REMOTE === '1'
    || process.env.PULSE_JARVIS_ALLOW_REMOTE?.toLowerCase() === 'true'
    || config.jarvis?.allowRemote === true
  const jarvisEnabled = explicitJarvis ?? false
  if (jarvisEnabled) assertJarvisApiUrl(jarvisUrl ?? 'http://127.0.0.1:7330', jarvisAllowRemote)

  const jarvis = {
    enabled: jarvisEnabled,
    ...(jarvisUrl ? { apiUrl: jarvisUrl } : {}),
    ...(jarvisToken ? { token: jarvisToken } : {}),
    ...(jarvisBudget ? { contextTokenBudget: jarvisBudget } : {}),
    autoCandidate: jarvisAutoCandidate,
    allowRemote: jarvisAllowRemote,
  }

  return {
    ...(explicitTaskController === undefined ? {} : { taskController: explicitTaskController }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(dataDir === undefined ? {} : { dataDir }),
    ...(systemPrompt && systemPrompt.trim().length > 0 ? { systemPrompt: systemPrompt.trim() } : {}),
    provider,
    providerProfiles,
    providerModels,
    automation: { ...(capabilitySettings.browser ? { browser: capabilitySettings.browser } : {}), ...(capabilitySettings.computer ? { computer: capabilitySettings.computer } : {}) },
    modelPricing: Object.fromEntries(selections.flatMap(({ id, model }) => model.pricing ? [[id, model.pricing]] : [])),
    ...(taskRouting === undefined ? {} : { taskRouting }),
    capabilityPacks,
    skillConfigPath: resolve(expandHome(option(parsed.options, 'config') ?? process.env.PULSE_CONFIG) ?? defaultPulseConfigPath()),
    enabledCapabilityPacks,
    capabilityConfig: capabilitySettings.skills === undefined ? {} : { skills: skillNames },
    activeProviderCode: providerName,
    activeModel: activeModelName,
    assistantModel: assistantModelName,
    ...(mockResponse === undefined ? {} : { mockResponse }),
    ...(mockTaskAssessments === undefined ? {} : { mockTaskAssessments }),
    ...(mockStageAssessments === undefined ? {} : { mockStageAssessments }),
    ...(mockToolCalls === undefined ? {} : { mockToolCalls }),
    ...(mockAfterToolResponse === undefined ? {} : { mockAfterToolResponse }),
    ...(mockParallelPlan === undefined ? {} : { mockParallelPlan }),
    ...(approvalMode === undefined ? {} : { approvalMode }),
    ...(configuredMaxTurns === undefined ? {} : { maxTurns: configuredMaxTurns }),
    maxModelCalls: configuredMaxModelCalls,
    ...(option(parsed.options, 'accept-build-migration') ? { recoveryBuildMigration: (() => { const pair = option(parsed.options, 'accept-build-migration')!.split(':'); if (pair.length !== 2 || pair.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid build migration pair; use the two hashes in the recovery diagnostic.'); return { from: pair[0]!, to: pair[1]! } })() } : {}),
    ...(config.modelBudgetPolicy === undefined ? {} : { modelBudgetPolicy: config.modelBudgetPolicy }),
    ...(config.persistenceBackend === undefined ? {} : { persistenceBackend: config.persistenceBackend }),
    ...(config.maxCostByCurrency === undefined ? {} : { maxCostByCurrency: config.maxCostByCurrency }),
    ...(configuredMaxRuntimeMs === undefined ? {} : { maxRuntimeMs: configuredMaxRuntimeMs }),
    ...(configuredAutoCompactPercent === undefined ? {} : { autoCompactPercent: Math.min(90, configuredAutoCompactPercent) }),
    ...(allowNetwork === undefined ? {} : { allowNetwork }),
    ...(config.networkHosts === undefined ? {} : { networkHosts: config.networkHosts }),
    jarvis,
    ...(config.frontModel ? { frontModel: (() => {
      const selected = typeof config.frontModel?.model === 'string' ? resolveModelReference(catalog, config.frontModel.model) : undefined
      const entry = selections.find(item => item.id === selected)
      const source = entry && effectiveProviders[entry.providerId]
      return { ...config.frontModel, ...(entry && source ? { provider: source.provider, model: entry.model.modelCode, ...(source.baseURL ? { baseURL: source.baseURL } : {}), ...(entry && resolvedKeys[entry.providerId] ? { apiKey: resolvedKeys[entry.providerId]! } : {}) } : {}) }
    })() } : {}),
    ...(config.approvalReview?.model ? { approvalReview: (() => {
      const selected = resolveModelReference(catalog, config.approvalReview!.model!)
      const entry = selections.find(item => item.id === selected)
      const source = entry && effectiveProviders[entry.providerId]
      if (!entry || !source || (source.provider !== 'ollama' && source.provider !== 'deepseek') || source.provider === 'ollama' && (entry.model.remote === true || /(?:-cloud|:cloud)$/.test(entry.model.modelCode))) throw new Error('APPROVAL_REVIEW_PROVIDER_UNSUPPORTED')
      return { provider: source.provider, model: entry.model.modelCode, baseURL: source.baseURL ?? (source.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com'), ...(source.provider === 'deepseek' ? { apiKeyEnv: source.apiKeyEnv ?? 'DEEPSEEK_API_KEY', ...(resolvedKeys[entry.providerId] ? { apiKey: resolvedKeys[entry.providerId]! } : {}) } : {}), timeoutMs: Math.max(30_000, Math.min(60_000, config.approvalReview!.timeoutMs ?? 30_000)) }
    })() } : {}),
  }
}

export async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2))
  if (parsed.options.help || parsed.options.h) {
    process.stdout.write(help)
    return 0
  }
  if (parsed.options.version || parsed.options.v) {
    process.stdout.write(formatVersionOutput(version, {
      color: parsed.options['no-color'] !== true && shouldUseColor(process.env, process.stdout.isTTY === true),
    }))
    return 0
  }

  if (parsed.command === 'setup') {
    return runSetup(parsed.options.force === true, expandHome(option(parsed.options, 'config')))
  }

  if (parsed.command === 'update') return runUpdateCommand(parsed.positionals, parsed.options, version)

  const options = await hostOptions(parsed)

  if (parsed.command === 'automation') {
    if (parsed.positionals[0] === 'permissions') { process.stdout.write(JSON.stringify(await requestAutomationPermissions(options.automation), null, 2) + '\n'); return 0 }
    if (parsed.positionals[0] !== 'doctor') throw new Error('Usage: pulse automation doctor|permissions')
    if (parsed.options.live === true) {
      const host = createLocalHost(options)
      try { process.stdout.write(JSON.stringify(await host.probeVisionModel(option(parsed.options, 'model') ?? options.taskRouting?.vision?.[0] ?? options.activeModel ?? ''), null, 2) + '\n'); return 0 } finally { await host.close() }
    }
    const report = await automationDoctor(options.automation)
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return (report.desktop as { error?: string }).error && options.enabledCapabilityPacks?.includes('computer') ? 1 : 0
  }

  if (parsed.command === 'doctor') {
    return runDoctor(options, parsed.options.live === true, option(parsed.options, 'format') ?? 'text')
  }

  if (parsed.command === 'drafts') {
    const [conversationId, runId, draftId] = parsed.positionals
    if (!conversationId || !runId || !draftId) throw new Error('Usage: pulse drafts <conversation-id> <run-id> <draft-id> [--revision <hash> --confirm-owner]')
    const host = createLocalHost(options)
    try { process.stdout.write(JSON.stringify(await host.migrateDraft(conversationId, runId, draftId, option(parsed.options, 'revision'), parsed.options['confirm-owner'] === true), null, 2) + '\n'); return 0 } finally { await host.close() }
  }
  if (parsed.command === 'sessions') {
    return runSessions(options, option(parsed.options, 'format') ?? 'text', version)
  }

  if (parsed.command === 'schedule') {
    return runScheduledCommand(options, parsed.positionals, parsed.options)
  }
  if (parsed.command === 'service') return runServiceCommand(options, parsed.positionals)
  if (parsed.command === 'h5') {
    const configPath = expandHome(option(parsed.options, 'config') ?? process.env.PULSE_CONFIG) ?? defaultPulseConfigPath()
    const prepare = (candidatePath: string) => hostOptions({ ...parsed, options: { ...parsed.options, config: candidatePath } })
    return runH5Command(options, parsed.positionals, parsed.options, { path: configPath, prepare })
  }
  if (parsed.command === 'mcp' && parsed.positionals[0] === 'doctor') return runMcpDoctor(options, parsed.positionals.slice(1))
  if (parsed.command === 'template') return runTemplateCommand(options, parsed.positionals, option(parsed.options, 'format') ?? 'text', version)

async function readPipedStdin(): Promise<string> {
  if (process.stdin.isTTY) return ''
  return new Promise<string>((resolve) => {
    let data = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(idle)
      process.stdin.pause()
      resolve(data.trim())
    }
    // An open stdin with no bytes must not block a command that already has a task.
    const idle = setTimeout(finish, 250)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      data += chunk
      clearTimeout(idle)
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    if (process.stdin.readableEnded) finish()
  })
}

  if (parsed.command === 'run') {
    let task = parsed.positionals.join(' ').trim()
    if (!task && !process.stdin.isTTY) {
      task = await readPipedStdin()
    } else if (task && !process.stdin.isTTY) {
      const piped = await readPipedStdin()
      if (piped) task = `${task}\n\n${piped}`
    }
    if (!task) throw new Error('TASK_REQUIRED')
    return runOneShot(options, task, option(parsed.options, 'format') ?? 'text', version, option(parsed.options, 'requirements-doc') ? [option(parsed.options, 'requirements-doc')!] : undefined)
  }

  if (parsed.command === 'resume') {
    const id = parsed.positionals.shift()
    let task = parsed.positionals.join(' ').trim()
    if (!task && !process.stdin.isTTY) {
      task = await readPipedStdin()
    }
    if (!id) throw new Error('RESUME_REQUIRES_ID')
    return runResume(options, id, task || undefined, option(parsed.options, 'format') ?? 'text', version)
  }

  // 默认启动交互式 Ink 界面
  const initialTask = parsed.positionals.join(' ').trim() || undefined
  return runInteractive(options, undefined, initialTask, version, parsed.options.resume === true)
}

if (process.argv[1] && isSameModulePath(process.argv[1], fileURLToPath(import.meta.url))) {
  if (process.env.PULSE_DESKTOP_DIAGNOSTICS === '1' && process.env.PULSE_LOG_DIR && process.argv[2] === 'h5' && ['start', 'daemon'].includes(process.argv[3] ?? '')) {
    try { installProcessDiagnostics(process.env.PULSE_LOG_DIR) } catch { /* Startup remains available if local diagnostics are unavailable. */ }
  }
  main()
    .then((code) => {
      process.exitCode = code
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
      process.exitCode = 1
    })
}
