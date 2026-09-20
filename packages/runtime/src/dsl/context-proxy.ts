import type { JsonValue } from '../core/types.js'

export interface DraftChanges { value: JsonValue; ops: Array<{ op: 'set'; path: string[]; value: JsonValue } | { op: 'append'; path: string[]; value: JsonValue } | { op: 'remove'; path: string[] }> }

export function createDraftProxy<T extends Record<string, unknown>>(initial: T): { draft: T; changes(): DraftChanges } {
  const value = structuredClone(initial)
  const ops: DraftChanges['ops'] = []
  const proxies = new WeakMap<object, object>()
  const wrap = (target: object, basePath: string[]): object => {
    const existing = proxies.get(target)
    if (existing) return existing
    const proxy = new Proxy(target, {
      get(current, property, receiver) {
        if (Array.isArray(current) && typeof property === 'string') {
          if (property === 'push') return (...items: unknown[]): number => { for (const item of items) { current.push(structuredClone(item)); ops.push({ op: 'append', path: basePath, value: structuredClone(item) as JsonValue }) }; return current.length }
          if (property === 'splice') return (start: number, deleteCount?: number, ...items: unknown[]): unknown[] => { const result = Array.prototype.splice.call(current, start, deleteCount ?? current.length - start, ...items.map((item) => structuredClone(item))); ops.push({ op: 'set', path: basePath, value: structuredClone(current) as JsonValue }); return result }
          if (property === 'sort') return (compareFn?: (left: unknown, right: unknown) => number): unknown[] => { Array.prototype.sort.call(current, compareFn); ops.push({ op: 'set', path: basePath, value: structuredClone(current) as JsonValue }); return current }
        }
        const next = Reflect.get(current, property, receiver)
        return typeof property === 'string' && next !== null && typeof next === 'object' ? wrap(next as object, [...basePath, property]) : next
      },
      set(current, property, next, receiver) {
        if (typeof property === 'string') {
          if (Array.isArray(current) && (/^\d+$/.test(property) || property === 'length')) {
            const result = Reflect.set(current, property, next, receiver)
            if (property !== 'length') ops.push({ op: 'set', path: basePath, value: structuredClone(current) as JsonValue })
            return result
          }
          ops.push({ op: 'set', path: [...basePath, property], value: structuredClone(next) as JsonValue })
        }
        return Reflect.set(current, property, next, receiver)
      },
      deleteProperty(current, property) {
        const result = Reflect.deleteProperty(current, property)
        if (typeof property === 'string') ops.push(Array.isArray(current) && /^\d+$/.test(property) ? { op: 'set', path: basePath, value: structuredClone(current) as JsonValue } : { op: 'remove', path: [...basePath, property] })
        return result
      },
    })
    proxies.set(target, proxy)
    return proxy
  }
  const draft = wrap(value, []) as T
  return { draft, changes: () => ({ value: value as JsonValue, ops: [...ops] }) }
}
