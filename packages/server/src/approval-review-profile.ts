import type { ProviderPresetConfig } from '@hunterzhu/pulse-adapters'

export interface ApprovalReviewConfig {
  provider: 'ollama' | 'deepseek'
  model: string
  baseURL: string
  apiKeyEnv?: string
  apiKey?: string
  timeoutMs: number
  manualOnRejection?: boolean
}

/** Explicit reviewer configuration; never borrow the worker's model or credentials. */
export function approvalReviewProfile(config: ApprovalReviewConfig | undefined): ProviderPresetConfig {
  if (!config?.model?.trim() || !['ollama', 'deepseek'].includes(config.provider)) throw Object.assign(new Error('reviewer_not_configured'), { code: 'REVIEWER_NOT_CONFIGURED' })
  if (config.provider === 'ollama' && /(?:-cloud|:cloud)$/.test(config.model)) throw Object.assign(new Error('reviewer_must_be_local'), { code: 'REVIEWER_ENDPOINT_INVALID' })
  const endpoint = new URL(config.baseURL)
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || config.provider === 'ollama' && !local || config.provider === 'deepseek' && !local && endpoint.protocol !== 'https:') {
    throw Object.assign(new Error(config.provider === 'ollama' ? 'reviewer_must_be_local' : 'reviewer_endpoint_invalid'), { code: 'REVIEWER_ENDPOINT_INVALID' })
  }
  const baseURL = endpoint.pathname.replace(/\/$/, '').endsWith('/v1') ? config.baseURL.replace(/\/$/, '') : `${config.baseURL.replace(/\/$/, '')}/v1`
  const apiKey = config.provider === 'deepseek' ? config.apiKey ?? process.env[config.apiKeyEnv ?? 'DEEPSEEK_API_KEY'] : undefined
  if (config.provider === 'deepseek' && !apiKey) throw Object.assign(new Error('reviewer_credential_missing'), { code: 'REVIEWER_CREDENTIAL_MISSING' })
  return { provider: config.provider, defaultModel: config.model, baseURL, reasoningEffort: 'none', ...(apiKey ? { apiKey } : {}) }
}
