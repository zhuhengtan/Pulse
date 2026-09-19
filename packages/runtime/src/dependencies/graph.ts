import type { TargetRef } from '../core/types.js'

export interface DependencyEdge { from: TargetRef; to: TargetRef; kind: 'wait' | 'ownership' }

export class DependencyGraph {
  private readonly edges = new Map<string, Set<string>>()
  private readonly reverse = new Map<string, Set<string>>()

  add(from: TargetRef, to: TargetRef, kind: DependencyEdge['kind'] = 'wait'): void {
    if (kind === 'ownership') return
    const source = `${from.kind}:${from.id}`
    const target = `${to.kind}:${to.id}`
    if (!this.edges.has(source)) this.edges.set(source, new Set())
    if (!this.reverse.has(target)) this.reverse.set(target, new Set())
    this.edges.get(source)!.add(target)
    this.reverse.get(target)!.add(source)
  }

  remove(from: TargetRef, to: TargetRef): void {
    this.edges.get(`${from.kind}:${from.id}`)?.delete(`${to.kind}:${to.id}`)
    this.reverse.get(`${to.kind}:${to.id}`)?.delete(`${from.kind}:${from.id}`)
  }

  hasCycle(): boolean {
    const visited = new Set<string>()
    const active = new Set<string>()
    const visit = (node: string): boolean => {
      if (active.has(node)) return true
      if (visited.has(node)) return false
      visited.add(node)
      active.add(node)
      for (const child of this.edges.get(node) ?? []) if (visit(child)) return true
      active.delete(node)
      return false
    }
    return [...this.edges.keys()].some(visit)
  }

  stronglyConnectedComponents(): string[][] {
    let index = 0
    const indices = new Map<string, number>()
    const low = new Map<string, number>()
    const stack: string[] = []
    const onStack = new Set<string>()
    const components: string[][] = []
    const visit = (node: string): void => {
      indices.set(node, index); low.set(node, index); index++; stack.push(node); onStack.add(node)
      for (const child of this.edges.get(node) ?? []) {
        if (!indices.has(child)) { visit(child); low.set(node, Math.min(low.get(node)!, low.get(child)!)) }
        else if (onStack.has(child)) low.set(node, Math.min(low.get(node)!, indices.get(child)!))
      }
      if (low.get(node) === indices.get(node)) {
        const component: string[] = []
        let popped = ''
        do { popped = stack.pop()!; onStack.delete(popped); component.push(popped) } while (popped !== node)
        components.push(component)
      }
    }
    for (const node of new Set([...this.edges.keys(), ...this.reverse.keys()])) if (!indices.has(node)) visit(node)
    return components
  }
}

export class WaitingIndex {
  private readonly waits = new Map<string, Set<string>>()
  add(target: TargetRef, waitId: string): void {
    const key = `${target.kind}:${target.id}`
    if (!this.waits.has(key)) this.waits.set(key, new Set())
    this.waits.get(key)!.add(waitId)
  }
  remove(target: TargetRef, waitId: string): void { this.waits.get(`${target.kind}:${target.id}`)?.delete(waitId) }
  waitingOn(target: TargetRef): string[] { return [...(this.waits.get(`${target.kind}:${target.id}`) ?? [])] }
}

export function detectDependencyCycle(edges: Array<{ from: TargetRef; to: TargetRef; kind?: 'wait' | 'ownership' }>): boolean {
  const graph = new DependencyGraph()
  for (const edge of edges) graph.add(edge.from, edge.to, edge.kind ?? 'wait')
  return graph.hasCycle()
}
