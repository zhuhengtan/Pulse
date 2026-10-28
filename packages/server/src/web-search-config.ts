import { parseWebSearchConfig, type WebSearchConfig } from './web-search.js'

/** A token is a transient settings draft field, never a persistent config field. */
export function webSearchDraft(value: unknown): { config?: WebSearchConfig | undefined; token?: string } {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WEB_SEARCH_CONFIG_INVALID')
  const { token, ...config } = value as Record<string, unknown>
  if (token !== undefined && (typeof token !== 'string' || token.length > 16384 || /[\r\n\0]/.test(token))) throw new Error('WEB_SEARCH_TOKEN_INVALID')
  if (token !== undefined) { delete config.credentialRef; delete config.apiKeyEnv }
  return { config: parseWebSearchConfig(config), ...(typeof token === 'string' ? { token: token.trim() } : {}) }
}
