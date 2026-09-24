import type { LocalHostOptions } from '@hunterzhu/pulse-server'

export async function runMcpDoctor(options: LocalHostOptions, ids: string[]): Promise<number> {
  const selected = options.enabledCapabilityPacks ?? []
  const requested = ids[0] ? selected.filter(id => id === ids[0]) : selected.filter(id => options.capabilityPacks?.some(pack => pack.manifest.id === id && pack.manifest.kind === 'mcp'))
  if (ids[0] && !requested.includes(ids[0])) throw new Error(`MCP_SERVER_NOT_ENABLED:${ids[0]}`)
  const rows: Array<{ id: string; status: string; tools?: string[]; error?: string }> = []
  for (const id of requested) {
    const pack = options.capabilityPacks?.find(item => item.manifest.id === id && item.manifest.kind === 'mcp')
    if (!pack) continue
    let activation: Awaited<ReturnType<typeof pack.activate>> | undefined
    try {
      activation = await pack.activate({ workspaceRoot: options.cwd ?? process.cwd(), config: options.capabilityConfig ?? {}, signal: new AbortController().signal })
      rows.push({ id, status: 'connected', tools: activation.tools.map(tool => tool.manifest.name) })
    } catch (error) {
      rows.push({ id, status: 'failed', error: error instanceof Error ? error.message.replace(/(API[_-]?KEY|TOKEN|SECRET|PASSWORD)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]') : 'MCP_CONNECTION_FAILED' })
    } finally { await activation?.dispose?.() }
  }
  if (!rows.length) { process.stdout.write('No enabled MCP servers. Configure capabilities.mcpServers and capabilities.enabled.\n'); return 1 }
  process.stdout.write(`${JSON.stringify({ servers: rows }, null, 2)}\n`)
  return rows.some(row => row.status !== 'connected') ? 1 : 0
}
