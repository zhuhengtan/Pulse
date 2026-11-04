import type { ReasoningEffort } from '@hunterzhu/pulse-runtime'

export const reasoningEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const satisfies readonly ReasoningEffort[]
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return reasoningEfforts.some(effort => effort === value)
}

const basic = ['low', 'medium', 'high'] as const
const extended = [...basic, 'xhigh', 'max'] as const
const openAILevels: Record<string, readonly ReasoningEffort[]> = {
  'gpt-5': ['minimal', ...basic], 'gpt-5-mini': ['minimal', ...basic], 'gpt-5-nano': ['minimal', ...basic], 'gpt-5-pro': ['high'],
  'gpt-5.1': ['none', ...basic], 'gpt-5.2': ['none', ...basic, 'xhigh'], 'gpt-5.2-pro': ['medium', 'high', 'xhigh'],
  'gpt-5.6': ['none', ...extended], 'gpt-6': ['none', ...extended], 'gpt-6-sol': ['none', ...extended], 'gpt-6-luna': ['none', ...extended],
  'gpt-6-astra': extended, 'gpt-6.1-sol': extended,
}
const claudeLevels: Record<string, readonly ReasoningEffort[]> = {
  'claude-opus-4-6': ['none', ...basic, 'max'], 'claude-sonnet-4-6': ['none', ...basic, 'max'],
  'claude-opus-4-7': extended, 'claude-opus-4-8': extended, 'claude-opus-5': ['none', ...extended],
  'claude-opus-5-5': extended, 'claude-sonnet-5': ['none', ...extended], 'claude-sonnet-5-5': extended,
  'claude-haiku-5-5': ['none', ...extended], 'claude-fable-5-1': extended, 'claude-mythos-5-1': extended,
}

export interface ReasoningSupport {
  levels: readonly ReasoningEffort[]
  verified: boolean
  protocol: 'effort' | 'anthropic-adaptive' | 'anthropic-budget'
}

/** Keep unknown models configurable, without claiming that their gateway honors the option. */
export function resolveReasoningSupport(provider: string, model: string, advertised?: readonly ReasoningEffort[]): ReasoningSupport {
  const code = model.toLowerCase().replace(/-(?:20\d{6}|20\d\d-\d\d-\d\d)$/, '')
  const legacyClaude = /^claude-(?:3-7|(?:sonnet|opus)-4(?:-0|-1|-5)?$)/.test(code)
  const protocol = provider === 'anthropic' ? legacyClaude ? 'anthropic-budget' : 'anthropic-adaptive' : 'effort'
  const known = (levels: readonly ReasoningEffort[]): ReasoningSupport => ({ levels, verified: true, protocol })
  const unknown = (levels: readonly ReasoningEffort[] = reasoningEfforts): ReasoningSupport => ({ levels, verified: false, protocol })
  if (advertised) return known(advertised.filter(isReasoningEffort))
  if (provider === 'mock') return known(reasoningEfforts)
  if (provider === 'openai') {
    const levels = openAILevels[code]
    if (levels) return known(levels)
    if (/^(?:gpt-4|gpt-3\.5|chatgpt-4o)/.test(code)) return known([])
    return unknown()
  }
  if (provider === 'anthropic') {
    if (claudeLevels[code]) return known(claudeLevels[code]!)
    if (legacyClaude) return known(['none', ...basic])
    if (/^claude-(?:[12](?:-|$)|3-(?!7)|haiku-4-5)/.test(code)) return known([])
    return unknown(['none', ...extended])
  }
  if (provider === 'deepseek') return /^(?:deepseek-flash|deepseek-v4-(?:flash|pro))$/.test(code) ? known(['none', 'low', 'high', 'max']) : unknown(['none', 'low', 'high', 'max'])
  if (provider === 'openai-compatible' || provider === 'openrouter') return unknown()
  if (provider.startsWith('ollama')) return /^gpt-oss(?:[:\-]|$)/.test(code) ? known(basic) : unknown(['none', ...basic])
  if (provider === 'minimax' && /^minimax-m3/.test(code)) return unknown()
  return known([])
}

export function reasoningRequestError(provider: string, model: string, effort: ReasoningEffort, reason = 'UNSUPPORTED') {
  return Object.assign(new Error(`${provider}/${model} cannot use reasoning effort ${effort}${reason === 'OUTPUT_BUDGET' ? ' with the configured output token limit' : ''}.`), { code: `PROVIDER_REASONING_${reason}`, retryable: true })
}
export function rejectedReasoningParameter(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { code?: string }).code
  return code === 'PROVIDER_WS_REASONING_REJECTED' || code === 'PROVIDER_HTTP_400' && /reasoning|thinking|output_config\.effort/i.test(error.message)
}
