import { z } from 'zod'

export const protocols = Object.freeze({ http: 1, events: 1, bridge: 1, nativeBrowser: 1, reader: 1 })
const version = z.string().regex(/^\d+\.\d+\.\d+$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const fileSchema = z.union([
  z.object({ bytes: z.number().int().nonnegative(), sha256: digest, mode: z.number().int().optional() }).strict(),
  z.object({ link: z.string().min(1) }).strict(),
])
export const componentSchema = z.object({
  schema: z.literal(1), component: z.enum(['backend', 'frontend', 'shell']), version,
  platform: z.string(), arch: z.string(), notes: z.string().max(20000).default(''),
  requires: z.object({ backend: version.optional(), shell: version.optional(), chromium: z.number().int().optional(),
    http: z.number().int().positive(), events: z.number().int().positive(), bridge: z.number().int().positive(), nativeBrowser: z.number().int().positive(), reader: z.number().int().positive(),
  }).strict(),
  data: z.object({ min: z.number().int().positive(), max: z.number().int().positive(), writes: z.number().int().positive(), reversible: z.boolean() }).strict(),
  artifact: z.object({ url: z.string().url(), bytes: z.number().int().positive().max(8 * 1024 ** 3), sha256: digest }).strict(),
  files: z.record(fileSchema),
}).strict()
export type ComponentManifest = z.infer<typeof componentSchema>
export type ComponentMetadata = Omit<ComponentManifest, 'files'>
export const indexSchema = z.object({
  schema: z.literal(1), sequence: z.number().int().nonnegative(), expiresAt: z.string().datetime(),
  releases: z.array(z.object({ component: z.enum(['backend', 'frontend', 'shell']), version,
    platform: z.string(), arch: z.string(), url: z.string().url(), sha256: digest,
  }).strict()).max(1000),
}).strict()
export type UpdateIndex = z.infer<typeof indexSchema>
export type SignedEnvelope = { keyId: string; payload: string; signature: string }
export type InstalledComponent = { directory: string; manifest: ComponentMetadata }
export type Selection = { backend?: InstalledComponent; frontend?: InstalledComponent }
export type UpdateState = {
  schema: 1; autoDownload: boolean; sequence: number; checkedAt?: string; error?: string;
  phase: 'idle' | 'checking' | 'downloading' | 'ready' | 'waiting' | 'applying' | 'failed';
  progress?: { component: string; received: number; total: number };
  downloadId?: string;
  shell?: { version: string; chromium: number };
  active: Selection; previous?: Selection; staged?: Selection; pending: boolean;
  lastBackend?: InstalledComponent;
  lastFailure?: { version: string; code: string; at: string };
  failed: string[]; blocked: string[]; available: ComponentMetadata[];
}
export function compareVersion(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { const delta = left[i]! - right[i]!; if (delta) return delta }
  return 0
}
export function releaseId(m: ComponentMetadata): string { return `${m.component}-${m.version}-${m.artifact.sha256.slice(0, 16)}` }
export function compatible(m: ComponentMetadata, context: { backend: string; shell?: string; chromium?: number; data: number }): string[] {
  const reasons: string[] = []
  for (const key of ['http', 'events', 'bridge', 'nativeBrowser', 'reader'] as const) if (m.requires[key] !== protocols[key]) reasons.push(`${key.toUpperCase()}_PROTOCOL_REQUIRED`)
  if (m.platform !== 'any' && m.platform !== process.platform || m.arch !== 'any' && m.arch !== process.arch) reasons.push('PLATFORM_MISMATCH')
  if (m.requires.backend && compareVersion(context.backend, m.requires.backend) < 0) reasons.push('BACKEND_REQUIRED')
  if (m.requires.shell && (!context.shell || compareVersion(context.shell, m.requires.shell) < 0)) reasons.push('SHELL_REQUIRED')
  if (m.requires.chromium && (context.chromium === undefined || context.chromium < m.requires.chromium)) reasons.push('CHROMIUM_REQUIRED')
  if (context.data < m.data.min || context.data > m.data.max || m.data.writes !== context.data || !m.data.reversible) reasons.push('MANUAL_DATA_MIGRATION_REQUIRED')
  return reasons
}
