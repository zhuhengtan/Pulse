import { z } from 'zod'
import type { StepContext, JsonValue } from '@hunterzhu/pulse-runtime'
import type { ControlledTask, PlannedTask } from './state.js'

/** Dependency-connected work stays on one context line. Disconnected deliveries may fork. */
export function deliveryChains(tasks: readonly PlannedTask[]): string[][] {
  const remaining = new Set(tasks.map(t => t.id)), groups: string[][] = []
  while (remaining.size) {
    const members = new Set([remaining.values().next().value!])
    let changed = true
    while (changed) {
      changed = false
      for (const t of tasks) if (members.has(t.id) || t.dependsOn.some(id => members.has(id))) {
        for (const id of [t.id, ...t.dependsOn]) if (remaining.has(id) && !members.has(id)) { members.add(id); changed = true }
      }
    }
    const group = tasks.filter(t => members.has(t.id)).map(t => t.id)
    group.forEach(id => remaining.delete(id)); groups.push(group)
  }
  return groups
}

// A handoff is an index, not a transcript or an alternative source of acceptance.
export const deliverySchema = z.object({
  version: z.literal(1), stageId: z.string().max(64), ownerLaneId: z.string().max(80),
  status: z.enum(['passed', 'blocked']), summary: z.string().max(200),
  lookup: z.object({ tool: z.literal('task.delivery'), stageId: z.string().max(64) }),
  evidence: z.array(z.object({ ref: z.string().max(80), tool: z.string().max(80).optional(), hash: z.string().max(128).optional(), path: z.string().max(512).optional(), offset: z.number().optional(), nextOffset: z.number().nullable().optional(), exitCode: z.number().optional() })).max(12),
  evidenceCount: z.number().int().min(0), omitted: z.number().int().min(0),
})
export type StageDelivery = z.infer<typeof deliverySchema>
export function stageDelivery(ctx: StepContext<JsonValue>, task: ControlledTask): StageDelivery {
  const refs = [...new Set([...task.evidenceRefs, ...(task.contextRefs ?? [])])]
  const evidence: StageDelivery['evidence'] = []
  const base = { version: 1 as const, stageId: task.id, ownerLaneId: task.ownerLaneId ?? ctx.lane.id, status: task.status === 'passed' ? 'passed' as const : 'blocked' as const, lookup: { tool: 'task.delivery' as const, stageId: task.id }, summary: (task.note ?? task.status).slice(0, 200), evidenceCount: refs.length }
  for (const ref of refs) {
    const meta = ctx.results.meta(ref), body = ctx.results.read(ref)
    const value = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
    const entry = { ref, ...(meta?.toolName ? { tool: meta.toolName.slice(0, 80) } : {}), ...(typeof value.hash === 'string' ? { hash: value.hash.slice(0, 128) } : {}), ...(typeof value.path === 'string' ? { path: value.path.slice(0, 512) } : {}), ...(typeof value.offset === 'number' ? { offset: value.offset } : {}), ...(typeof value.nextOffset === 'number' || value.nextOffset === null ? { nextOffset: value.nextOffset } : {}), ...(typeof meta?.toolExitCode === 'number' ? { exitCode: meta.toolExitCode } : {}) }
    // Keep the total model-facing receipt below 4 KiB, including UTF-8 paths.
    if (evidence.length >= 12 || new TextEncoder().encode(JSON.stringify({ ...base, evidence: [...evidence, entry], omitted: refs.length - evidence.length - 1 })).length > 4096) break
    evidence.push(entry)
  }
  return deliverySchema.parse({ ...base, evidence, omitted: refs.length - evidence.length })
}
