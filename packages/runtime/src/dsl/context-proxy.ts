import type { JsonValue } from '../core/types.js'

export interface DraftChanges { value: JsonValue; ops: Array<{ op: 'set'; path: string[]; value: JsonValue } | { op: 'remove'; path: string[] }> }

export function createDraftProxy<T extends Record<string, unknown>>(initial: T): { draft: T; changes(): DraftChanges } {
  const value = structuredClone(initial)
  const ops: DraftChanges['ops'] = []
  const proxies = new WeakMap<object, object>()
  const wrap = (target: object, basePath: string[]): object => {
    const existing = proxies.get(target)
    if (existing) return existing
    const proxy = new Proxy(target, {
      get(current, property, receiver) {
        const next = Reflect.get(current, property, receiver)
        return typeof property === 'string' && next !== null && typeof next === 'object' ? wrap(next as object, [...basePath, property]) : next
      },
      set(current, property, next, receiver) {
        if (typeof property === 'string') ops.push({ op: 'set', path: [...basePath, property], value: structuredClone(next) as JsonValue })
        return Reflect.set(current, property, next, receiver)
      },
      deleteProperty(current, property) {
        if (typeof property === 'string') ops.push({ op: 'remove', path: [...basePath, property] })
        return Reflect.deleteProperty(current, property)
      },
    })
    proxies.set(target, proxy)
    return proxy
  }
  const draft = wrap(value, []) as T
  return { draft, changes: () => ({ value: value as JsonValue, ops: [...ops] }) }
}
