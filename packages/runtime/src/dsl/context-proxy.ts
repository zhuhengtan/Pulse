import type { JsonValue } from '../core/types.js'

export interface DraftChanges { value: JsonValue; ops: Array<{ op: 'set'; path: string[]; value: JsonValue }> }

export function createDraftProxy<T extends Record<string, unknown>>(initial: T): { draft: T; changes(): DraftChanges } {
  const value = structuredClone(initial)
  const ops: DraftChanges['ops'] = []
  const draft = new Proxy(value, {
    set(target, property, next) { if (typeof property === 'string') ops.push({ op: 'set', path: [property], value: next as JsonValue }); Reflect.set(target, property, next); return true },
  })
  return { draft, changes: () => ({ value: value as JsonValue, ops: [...ops] }) }
}
