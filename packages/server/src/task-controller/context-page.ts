export interface ContextNode {
  source: 'conversation' | 'stage' | 'evidence'
  id: string
  text: string
  /** Stage ids, criterion ids, dependency ids, evidence refs, or paths this record is attached to. */
  links: string[]
}

export interface ContextSurfaceHit {
  source: ContextNode['source']
  id: string
  ring: number
  text: string
}

export interface ContextSurface {
  hits: ContextSurfaceHit[]
  remaining: Array<{ source: ContextNode['source']; id: string; ring: number }>
}

const SNIPPET_CHARS = 500
const MAX_SNIPPETS = 8
const MAX_RINGS = 2
const SOURCE_ORDER: Record<ContextNode['source'], number> = { stage: 0, evidence: 1, conversation: 2 }

function snippet(text: string): string {
  let count = 0
  let output = ''
  for (const char of text) {
    if (count >= SNIPPET_CHARS) break
    output += char
    count++
  }
  return output
}

export interface SurfaceTask {
  id: string
  text: string
  criterionIds: readonly string[]
  dependsOn: readonly string[]
  evidenceRefs: readonly string[]
}

const PATH_PATTERN = /[A-Za-z0-9_./\\-]{3,}\.[A-Za-z0-9]+/g

/** Build the structural graph. Conversation enters only by citing an id or path already in the catalog. */
export function buildContextGraph(input: { criterionIds: readonly string[]; stages: readonly SurfaceTask[]; active?: SurfaceTask; evidenceText: ReadonlyMap<string, string>; conversation: readonly string[] }): { nodes: ContextNode[]; anchor: string[] } {
  const stages = input.active ? [...input.stages, input.active] : [...input.stages]
  const identifiers = new Set<string>([...input.criterionIds, ...stages.flatMap((task) => [task.id, ...task.criterionIds, ...task.dependsOn, ...task.evidenceRefs])])
  const evidenceOwners = new Map<string, string[]>()
  for (const task of stages) for (const ref of task.evidenceRefs) evidenceOwners.set(ref, [...(evidenceOwners.get(ref) ?? []), task.id])
  for (const text of input.evidenceText.values()) for (const path of text.match(PATH_PATTERN) ?? []) identifiers.add(path)
  const mentioned = (text: string) => [...identifiers].filter((identifier) => identifier.length >= 2 && text.includes(identifier))
  const nodes: ContextNode[] = [
    ...input.stages.map((task): ContextNode => ({ source: 'stage', id: task.id, text: task.text, links: [task.id, ...task.criterionIds, ...task.dependsOn, ...task.evidenceRefs] })),
    ...[...input.evidenceText].map(([ref, text]): ContextNode => ({ source: 'evidence', id: ref, text, links: [ref, ...(evidenceOwners.get(ref) ?? []), ...mentioned(text)] })),
    ...input.conversation.map((text, index): ContextNode => ({ source: 'conversation', id: `message-${index}`, text, links: mentioned(text) })),
  ]
  const anchor = input.active ? [input.active.id, ...input.active.criterionIds, ...input.active.dependsOn, ...input.active.evidenceRefs] : [...input.criterionIds]
  return { nodes, anchor }
}

/** Points already on the surface grown from the anchor. A new expansion must start at one of these. */
export function reachedSurfacePoints(anchorLinks: readonly string[], nodes: readonly ContextNode[]): Set<string> {
  const surface = expandContextSurface(anchorLinks, nodes)
  const points = new Set(anchorLinks.filter((link) => link.length > 0))
  for (const hit of surface.hits) {
    points.add(hit.id)
    const node = nodes.find((item) => item.source === hit.source && item.id === hit.id)
    for (const link of node?.links ?? []) if (link.length > 0) points.add(link)
  }
  for (const item of surface.remaining) points.add(item.id)
  return points
}

/** Expand from one point that the current surface already reached. Any other id is rejected. */
export function expandFromReachedPoint(anchorLinks: readonly string[], nodes: readonly ContextNode[], point: string): ContextSurface {
  if (!reachedSurfacePoints(anchorLinks, nodes).has(point)) throw new Error('POINT_NOT_REACHED')
  return expandContextSurface([point], nodes)
}

/**
 * Expand outward from an anchor, one ring at a time.
 * A farther record cannot jump ahead of a closer one, and a truncated ring keeps the remainder in that same order.
 */
export function expandContextSurface(anchorLinks: readonly string[], nodes: readonly ContextNode[], maxSnippets = MAX_SNIPPETS, maxRings = MAX_RINGS): ContextSurface {
  const reached = new Set(anchorLinks.filter((link) => link.length > 0))
  const emitted = new Set<string>()
  const hits: ContextSurfaceHit[] = []
  const remaining: ContextSurface['remaining'] = []
  for (let ring = 1; ring <= maxRings; ring++) {
    const ringNodes = nodes.filter((node) => !emitted.has(node.id) && node.links.some((link) => reached.has(link)))
      .map((node, index) => ({ node, index }))
      .sort((left, right) => SOURCE_ORDER[left.node.source] - SOURCE_ORDER[right.node.source] || left.index - right.index)
      .map((item) => item.node)
    let truncated = false
    for (const node of ringNodes) {
      if (emitted.has(node.id)) continue
      if (hits.length >= maxSnippets) {
        remaining.push({ source: node.source, id: node.id, ring })
        truncated = true
        continue
      }
      emitted.add(node.id)
      for (const link of node.links) reached.add(link)
      hits.push({ source: node.source, id: node.id, ring, text: snippet(node.text) })
    }
    if (truncated) break
  }
  return { hits, remaining }
}
