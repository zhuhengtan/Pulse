import type { ProviderPresetConfig } from '@hunterzhu/pulse-adapters'

export interface ApprovalReviewConfig extends ProviderPresetConfig {
  model: string
  apiKeyEnv?: string
  timeoutMs: number
  manualOnRejection?: boolean
}

/** Explicit reviewer configuration; never borrow the worker's model or credentials. */
export function approvalReviewProfile(config: ApprovalReviewConfig | undefined): ProviderPresetConfig {
  if (!config?.model?.trim() || !config.provider?.trim()) throw Object.assign(new Error('reviewer_not_configured'), { code: 'REVIEWER_NOT_CONFIGURED' })
  if (config.baseURL) {
    let endpoint: URL
    try { endpoint = new URL(config.baseURL) } catch { throw Object.assign(new Error('reviewer_endpoint_invalid'), { code: 'REVIEWER_ENDPOINT_INVALID' }) }
    const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(endpoint.hostname)
    const privateOllama = config.provider === 'ollama-remote' && (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(endpoint.hostname) || endpoint.hostname.endsWith('.local') || /^\[f[cd][0-9a-f]/i.test(endpoint.hostname))
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.protocol === 'http:' && !local && !privateOllama) {
      throw Object.assign(new Error('reviewer_endpoint_invalid'), { code: 'REVIEWER_ENDPOINT_INVALID' })
    }
  }
  const { model, timeoutMs: _timeout, manualOnRejection: _manual, apiKeyEnv, reasoningEffort, ...profile } = config
  const apiKey = config.apiKey ?? (apiKeyEnv ? process.env[apiKeyEnv] : config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined)
  if ((apiKeyEnv || config.provider === 'deepseek') && !apiKey) throw Object.assign(new Error('reviewer_credential_missing'), { code: 'REVIEWER_CREDENTIAL_MISSING' })
  return { ...profile, defaultModel: model, ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(apiKey ? { apiKey } : {}) }
}
