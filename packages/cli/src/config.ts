import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface PulseCliConfig {
  cwd?: string
  dataDir?: string
  provider?: { provider?: string; model?: string; baseURL?: string; apiKeyEnv?: string }
  approvalMode?: 'read-only' | 'ask' | 'auto'
  allowNetwork?: boolean
}

export function expandHome(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  return path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

function asConfig(value: unknown): PulseCliConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as PulseCliConfig
}

/** Workspace files must not escalate approval, network, or provider credentials. */
export function sanitizeWorkspaceConfig(value: PulseCliConfig): PulseCliConfig {
  const provider = value.provider === undefined ? undefined : {
    ...(value.provider.provider === undefined ? {} : { provider: value.provider.provider }),
    ...(value.provider.model === undefined ? {} : { model: value.provider.model }),
  }
  return {
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(value.dataDir === undefined ? {} : { dataDir: value.dataDir }),
    ...(provider === undefined || Object.keys(provider).length === 0 ? {} : { provider }),
  }
}

export function mergePulseConfigs(layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user' }>): PulseCliConfig {
  let merged: PulseCliConfig = {}
  for (const layer of layers) {
    const value = layer.trust === 'workspace' ? sanitizeWorkspaceConfig(layer.value) : layer.value
    merged = {
      ...merged,
      ...value,
      ...(merged.provider === undefined && value.provider === undefined ? {} : { provider: { ...merged.provider, ...value.provider } }),
    }
  }
  return merged
}

export async function loadPulseConfig(cwd: string, explicitPath?: string, trustWorkspace = false): Promise<{ value: PulseCliConfig; source?: string }> {
  const workspacePath = join(cwd, '.pulse', 'config.json')
  const homePath = join(homedir(), '.pulse', 'config.json')
  const envPath = expandHome(process.env.PULSE_CONFIG)
  const layers: Array<{ value: PulseCliConfig; trust: 'workspace' | 'user'; source: string }> = []
  for (const [path, trust] of [
    [workspacePath, trustWorkspace ? 'user' : 'workspace'],
    [homePath, 'user'],
    [envPath, 'user'],
    [explicitPath, 'user'],
  ] as const) {
    if (!path) continue
    try {
      const parsed = asConfig(JSON.parse(await readFile(path, 'utf8')))
      if (parsed) layers.push({ value: parsed, trust, source: path })
    } catch { /* absent or invalid config is reported by doctor */ }
  }
  return { value: mergePulseConfigs(layers), ...(layers.at(-1) === undefined ? {} : { source: layers.at(-1)!.source }) }
}
