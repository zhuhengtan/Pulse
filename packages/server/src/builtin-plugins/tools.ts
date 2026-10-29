import { z } from 'zod'
import { ToolRegistry, defineTool, createToolInputValidator } from '@hunterzhu/pulse-tool-sdk'
import { resolveWebSearchOptions, searchWeb } from '../web-search.js'
import { BuiltinPluginJobs } from './jobs.js'
import { mediaKinds, pluginFor, type MediaKind, type PluginId } from './config.js'
import { pluginError } from './http.js'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import type { EffectRecord, JsonValue, LLMRequestProjection } from '@hunterzhu/pulse-runtime'
import { AttachmentStore } from '../attachments.js'
import { readFile } from 'node:fs/promises'

export const generationTools = ['image.generate', 'video.generate', 'audio.generate']
export const pluginToolIds: Record<string, PluginId> = { 'web.search': 'web_search', 'image.generate': 'image_gen', 'video.generate': 'video_gen', 'audio.generate': 'audio_gen' }

/** Context was frozen at submission. Refresh the actual provider request too. */
export function refreshPluginProjection(effect: EffectRecord, registry: ToolRegistry): EffectRecord {
  const input = effect.input as Record<string, JsonValue>
  const request = input.request as unknown as LLMRequestProjection | undefined
  if (!request) return effect
  const query = input.toolDiscovery
  const blocks = request.blocks.map(block => {
    if (block.kind !== 'tools') return block
    const current = block.content && typeof block.content === 'object' && !Array.isArray(block.content) ? block.content as Record<string, JsonValue> : {}
    const tools = query && typeof query === 'object' && !Array.isArray(query)
      ? registry.discover(query as any).map(({ manifest }) => ({ name: manifest.name, description: manifest.description, inputSchema: manifest.inputSchema }))
      : Array.isArray(current.tools) ? current.tools.filter(t => t && typeof t === 'object' && !Array.isArray(t) && typeof t.name === 'string' && registry.isAllowed(t.name)) : []
    return { ...block, content: { tools } as unknown as JsonValue }
  })
  const hash = createHash('sha256').update(JSON.stringify(blocks)).digest('hex')
  return { ...effect, input: { ...input, request: { ...request, blocks, projectionHash: hash, prefixHash: hash, toolSetVersion: hash } as unknown as JsonValue } }
}

/** Dynamic filtering also applies to old tool sets and discoveries in live Runs. */
export class PluginToolRegistry extends ToolRegistry {
  private cataloguing = false
  constructor(policy: ConstructorParameters<typeof ToolRegistry>[0], readonly plugins: BuiltinPluginJobs) { super(policy) }
  catalog() { this.cataloguing = true; try { return super.list() } finally { this.cataloguing = false } }
  inputValidator() {
    // Runtime callbacks must be pure: snapshot schemas even for currently disabled
    // plugins. Live policy is checked at discovery, admission and execution.
    this.cataloguing = true
    try { return createToolInputValidator(this) } finally { this.cataloguing = false }
  }
  override isAllowed(name: string): boolean {
    const id = pluginToolIds[name]
    return (this.cataloguing || !id || this.plugins.enabled(id) && (id === 'web_search' || mediaKinds.some(kind => pluginFor(kind) === id && this.plugins.configured(kind)))) && super.isAllowed(name)
  }
}
export function createHostToolInputValidator(registry: ToolRegistry) {
  return registry instanceof PluginToolRegistry ? registry.inputValidator() : createToolInputValidator(registry)
}
const generated = z.object({ jobId: z.string(), path: z.string(), hash: z.string(), bytes: z.number(), mediaType: z.string(), label: z.string() })
export function registerPluginTools(registry: ToolRegistry, jobs: BuiltinPluginJobs, root: string, runId: string, configPath?: string, conversationId?: string): void {
  registry.register(defineTool({
    name: 'web.search', description: 'Search web pages with the enabled host search plugin. Use web.fetch to read a result.', tags: ['web', 'research'],
    input: z.object({ query: z.string().min(1).max(500), limit: z.number().int().min(1).max(10).default(5) }),
    output: z.object({ query: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string() })), fetchedAt: z.string() }),
    sideEffectPolicy: 'read', retrySafety: 'read_only', defaultTimeoutMs: 121_000,
    execute: async ({ query, limit }, context) => {
      if (!jobs.enabled('web_search')) throw pluginError('PLUGIN_DISABLED')
      const config = jobs.config()
      const search = configPath ? await resolveWebSearchOptions(config.webSearch, configPath) : config.webSearch
      return searchWeb(query, limit, context.signal, search)
    }, summarize: output => output,
  }))
  for (const [name, kind] of [['image.generate', 'image'], ['video.generate', 'video'], ['audio.generate', 'speech']] as const) {
    registry.register(defineTool({
      name, description: name === 'audio.generate' ? 'Generate speech (prompt is the exact spoken text), music, or a sound effect using the enabled host plugin. Only configured modes work. Return the saved artifact, never claim a failed generation succeeded.' : 'Generate a ' + kind + ' using the enabled host plugin. Reference images are existing workspace paths or attachment:<id> from attachment.list. The host owns service, model, credentials and output paths.',
      tags: ['media', 'generation', kind], sideEffectPolicy: 'external', retrySafety: 'unsafe', defaultTimeoutMs: 3_601_000,
      input: z.object({ prompt: z.string().min(1).max(20_000), mode: z.enum(['speech', 'music', 'sound']).optional(), referenceImages: z.array(z.string().max(2000)).max(kind === 'image' ? 4 : 1).optional(), parameters: z.object({ size: z.string().max(40).optional(), quality: z.string().max(40).optional(), aspectRatio: z.string().max(20).optional(), imageSize: z.string().max(20).optional(), duration: z.number().positive().max(600).optional(), resolution: z.string().max(20).optional(), voice: z.string().max(250).optional(), speed: z.number().min(0.25).max(4).optional(), seed: z.number().int().nonnegative().optional(), lyrics: z.string().max(10000).optional(), instrumental: z.boolean().optional(), loop: z.boolean().optional() }).strict().optional() }).strict(),
      output: generated,
      executionRef: (_input, context) => ({ jobId: jobs.id(runId, context.effectId) }),
      execute: (input, context) => jobs.generate(root, runId, context.effectId, name === 'audio.generate' ? input.mode ?? 'speech' : kind, input, context.signal, state => context.emit({ type: 'progress', data: { plugin: pluginToolIds[name]!, state } }), async path => {
        if (!conversationId) throw pluginError('PLUGIN_REFERENCE_INVALID')
        const id = path.slice(11), store = new AttachmentStore(jobs.dataDir, conversationId)
        if (!(await store.accessible()).has(id)) throw pluginError('PLUGIN_REFERENCE_INVALID')
        const meta = await store.metadata(id)
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(meta.mediaType) || meta.size > 20 * 1024 * 1024) throw pluginError('PLUGIN_REFERENCE_INVALID')
        return { bytes: await readFile(join(store.directory, id)), mediaType: meta.mediaType }
      }),
      reconcile: async (ref, context) => {
        const jobId = ref && typeof ref === 'object' && !Array.isArray(ref) && typeof ref.jobId === 'string' ? ref.jobId : ''
        const output = await jobs.reconcile(jobId, context.signal)
        return output ? { status: 'succeeded' as const, output } : { status: 'unknown' as const }
      },
      summarize: output => ({ ...output }),
    }))
  }
}
