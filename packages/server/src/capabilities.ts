import type { ToolDefinition } from '@hunterzhu/pulse-tool-sdk'
import type { JsonValue } from '@hunterzhu/pulse-runtime'
import { createDocumentTools } from '@hunterzhu/pulse-adapters'
import { createMcpStdioAdapter, type McpStdioClientOptions } from '@hunterzhu/pulse-adapters'

export type CapabilityPackKind = 'mcp' | 'skill' | 'integration'

export interface CapabilityPackManifest {
  id: string
  version: string
  kind: CapabilityPackKind
  title: string
  description: string
  requiredConfig?: string[]
}

export interface CapabilityPackContext {
  workspaceRoot: string
  config: Readonly<Record<string, JsonValue>>
  signal: AbortSignal
}

export interface CapabilityPackActivation {
  tools: ToolDefinition[]
  instructions?: string[]
  dispose?: () => Promise<void> | void
}

/**
 * A trusted, host-installed extension. Workspace files may select a pack ID,
 * but they cannot provide executable code or override the host configuration.
 */
export interface CapabilityPack {
  manifest: CapabilityPackManifest
  activate(context: CapabilityPackContext): Promise<CapabilityPackActivation>
}

export interface ActiveCapabilityPacks {
  tools: ToolDefinition[]
  instructions: string[]
  manifests: CapabilityPackManifest[]
  dispose(): Promise<void>
}

const packIdPattern = /^[a-z][a-z0-9-]{1,63}$/

function validatePack(pack: CapabilityPack): void {
  const manifest = pack?.manifest
  if (!manifest || typeof manifest !== 'object') throw new Error('INVALID_CAPABILITY_PACK')
  if (!packIdPattern.test(manifest.id)) throw new Error('INVALID_CAPABILITY_PACK_ID')
  if (typeof manifest.version !== 'string' || !manifest.version.trim() || typeof manifest.title !== 'string' || !manifest.title.trim() || typeof manifest.description !== 'string' || !manifest.description.trim()) throw new Error('INVALID_CAPABILITY_PACK_MANIFEST')
  if (manifest.kind !== 'mcp' && manifest.kind !== 'skill' && manifest.kind !== 'integration') throw new Error('INVALID_CAPABILITY_PACK_KIND')
  if (typeof pack.activate !== 'function') throw new Error('INVALID_CAPABILITY_PACK_ACTIVATOR')
  if (manifest.requiredConfig?.some((key) => !/^[A-Z][A-Z0-9_]{0,63}$/.test(key))) throw new Error('INVALID_CAPABILITY_PACK_CONFIG_KEY')
}

export class CapabilityPackRegistry {
  private readonly packs = new Map<string, CapabilityPack>()

  register(pack: CapabilityPack): void {
    validatePack(pack)
    if (this.packs.has(pack.manifest.id)) throw new Error(`CAPABILITY_PACK_EXISTS:${pack.manifest.id}`)
    this.packs.set(pack.manifest.id, pack)
  }

  list(): CapabilityPackManifest[] {
    return [...this.packs.values()].map(({ manifest }) => structuredClone(manifest))
  }

  async activate(ids: readonly string[], context: CapabilityPackContext): Promise<ActiveCapabilityPacks> {
    if (new Set(ids).size !== ids.length) throw new Error('DUPLICATE_CAPABILITY_PACK_ID')
    const active: CapabilityPackActivation[] = []
    const manifests: CapabilityPackManifest[] = []
    const tools: ToolDefinition[] = []
    const toolNames = new Set<string>()
    try {
      for (const id of ids) {
        const pack = this.packs.get(id)
        if (!pack) throw new Error(`UNKNOWN_CAPABILITY_PACK:${id}`)
        const missing = (pack.manifest.requiredConfig ?? []).filter((key) => context.config[key] === undefined)
        if (missing.length > 0) throw new Error(`CAPABILITY_PACK_CONFIG_REQUIRED:${id}:${missing.join(',')}`)
        const result = await pack.activate(context)
        if (!result || typeof result !== 'object') throw new Error(`INVALID_CAPABILITY_PACK_ACTIVATION:${id}`)
        active.push(result)
        if (!result || !Array.isArray(result.tools) || (result.instructions !== undefined && (!Array.isArray(result.instructions) || result.instructions.some((instruction) => typeof instruction !== 'string')))) throw new Error(`INVALID_CAPABILITY_PACK_ACTIVATION:${id}`)
        for (const tool of result.tools) {
          const name = tool?.manifest?.name
          if (typeof name !== 'string' || !name.startsWith(`${id}.`)) throw new Error(`CAPABILITY_TOOL_NAMESPACE_REQUIRED:${id}`)
          if (toolNames.has(name)) throw new Error(`CAPABILITY_TOOL_COLLISION:${name}`)
          toolNames.add(name)
          tools.push(tool)
        }
        manifests.push(structuredClone(pack.manifest))
      }
    } catch (error) {
      try { await disposeInReverse(active) } catch (disposeError) { throw new AggregateError([error, disposeError], 'CAPABILITY_PACK_ACTIVATION_AND_ROLLBACK_FAILED') }
      throw error
    }
    let disposed = false
    return {
      tools,
      instructions: active.flatMap((activation) => activation.instructions ?? []),
      manifests,
      dispose: async () => {
        if (disposed) return
        disposed = true
        await disposeInReverse(active)
      },
    }
  }
}

async function disposeInReverse(activations: CapabilityPackActivation[]): Promise<void> {
  const failures: unknown[] = []
  for (const activation of [...activations].reverse()) {
    try { await activation.dispose?.() } catch (error) { failures.push(error) }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'CAPABILITY_PACK_DISPOSAL_FAILED')
}

/** Catalog entries are descriptive only; an installed adapter must register
 * the matching pack before it can be enabled. No connector is simulated. */
export const referenceCapabilityPackCatalog: readonly CapabilityPackManifest[] = [
  { id: 'mcp', version: '1', kind: 'mcp', title: 'MCP servers', description: 'Host-installed Model Context Protocol servers with explicit tool and network policies.' },
  { id: 'skills', version: '1', kind: 'skill', title: 'Skills', description: 'Reviewed, host-installed task instructions and workflows; project files cannot execute as plugins.' },
  { id: 'jarvis', version: '1', kind: 'integration', title: 'Jarvis memory', description: 'Optional session-scoped memory and context integration.' },
  { id: 'browser', version: '1', kind: 'integration', title: 'Browser', description: 'Optional Playwright-based browser research and interaction adapter.' },
  { id: 'pdf', version: '1', kind: 'integration', title: 'PDF', description: 'Optional PDF.js-based document extraction adapter.' },
  { id: 'spreadsheet', version: '1', kind: 'integration', title: 'Spreadsheets', description: 'Optional ExcelJS-based spreadsheet read/write adapter.' },
]

/** Read-only PDF extraction capability, installed by the host and enabled explicitly. */
export function createPdfCapabilityPack(): CapabilityPack {
  return {
    manifest: { id: 'pdf', version: '1', kind: 'integration', title: 'PDF reader', description: 'Bounded PDF text and metadata extraction inside the active workspace.' },
    async activate({ workspaceRoot }) {
      const tool = createDocumentTools(workspaceRoot).find((item) => item.manifest.name === 'document.pdf.read')
      if (!tool) throw new Error('PDF_TOOL_UNAVAILABLE')
      return { tools: [{ ...tool, manifest: { ...tool.manifest, name: 'pdf.read' } }] }
    },
  }
}

/** Read-only worksheet metadata and bounded cell preview capability. */
export function createSpreadsheetCapabilityPack(): CapabilityPack {
  return {
    manifest: { id: 'spreadsheet', version: '1', kind: 'integration', title: 'Spreadsheet reader', description: 'Bounded XLSX workbook metadata and cell preview inside the active workspace.' },
    async activate({ workspaceRoot }) {
      const tool = createDocumentTools(workspaceRoot).find((item) => item.manifest.name === 'document.xlsx.inspect')
      if (!tool) throw new Error('SPREADSHEET_TOOL_UNAVAILABLE')
      return { tools: [{ ...tool, manifest: { ...tool.manifest, name: 'spreadsheet.inspect' } }] }
    },
  }
}

/**
 * Wrap a host-configured MCP stdio process as one explicitly enabled pack.
 * The process is host-installed/trusted; remote tool calls remain external
 * Pulse tools and inherit the normal approval boundary.
 */
export function createMcpCapabilityPack(id: string, options: Omit<McpStdioClientOptions, 'namespace'> & { toolPolicies?: Record<string, 'read' | 'write' | 'external'> }): CapabilityPack {
  if (!packIdPattern.test(id)) throw new Error('INVALID_CAPABILITY_PACK_ID')
  return {
    manifest: { id, version: '1', kind: 'mcp', title: `MCP ${id}`, description: `Host-installed MCP stdio server ${id}; remote calls are treated as external side effects.` },
    async activate(context) {
      const { client, tools } = await createMcpStdioAdapter({ ...options, cwd: options.cwd ?? context.workspaceRoot, namespace: id })
      const policies = options.toolPolicies ?? {}
      return { tools: tools.map((tool) => {
        const remoteName = tool.manifest.name.slice(id.length + 1)
        const policy = policies[remoteName] ?? 'external'
        return { ...tool, manifest: { ...tool.manifest, sideEffectPolicy: policy, retrySafety: policy === 'read' ? 'read_only' : 'unsafe' } }
      }), dispose: () => client.close() }
    },
  }
}
