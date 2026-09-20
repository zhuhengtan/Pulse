export function matchesJsonSchema(value: unknown, schema: unknown): boolean {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false
  const document = schema as Record<string, unknown>
  if (Array.isArray(document.anyOf) && !document.anyOf.some((candidate) => matchesJsonSchema(value, candidate))) return false
  if (Array.isArray(document.oneOf) && document.oneOf.filter((candidate) => matchesJsonSchema(value, candidate)).length !== 1) return false
  if (Array.isArray(document.allOf) && document.allOf.some((candidate) => !matchesJsonSchema(value, candidate))) return false
  if (document.not !== undefined && matchesJsonSchema(value, document.not)) return false
  if (document.const !== undefined && JSON.stringify(value) !== JSON.stringify(document.const)) return false
  if (Array.isArray(document.enum) && !document.enum.some((candidate) => JSON.stringify(value) === JSON.stringify(candidate))) return false
  if (typeof document.type === 'string') {
    const matches = document.type === 'null' ? value === null
      : document.type === 'boolean' ? typeof value === 'boolean'
        : document.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
          : document.type === 'integer' ? typeof value === 'number' && Number.isInteger(value)
            : document.type === 'string' ? typeof value === 'string'
              : document.type === 'array' ? Array.isArray(value)
                : document.type === 'object' ? typeof value === 'object' && value !== null && !Array.isArray(value)
                  : false
    if (!matches) return false
  }
  if (typeof value === 'string') {
    if (typeof document.minLength === 'number' && value.length < document.minLength) return false
    if (typeof document.maxLength === 'number' && value.length > document.maxLength) return false
    if (typeof document.pattern === 'string') {
      try { if (!new RegExp(document.pattern).test(value)) return false } catch { return false }
    }
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof document.minimum === 'number' && value < document.minimum) return false
    if (typeof document.maximum === 'number' && value > document.maximum) return false
    if (typeof document.exclusiveMinimum === 'number' && value <= document.exclusiveMinimum) return false
    if (typeof document.exclusiveMaximum === 'number' && value >= document.exclusiveMaximum) return false
    if (typeof document.multipleOf === 'number' && document.multipleOf > 0 && Math.abs(value / document.multipleOf - Math.round(value / document.multipleOf)) > Number.EPSILON) return false
  }
  if (Array.isArray(value)) {
    if (typeof document.minItems === 'number' && value.length < document.minItems) return false
    if (typeof document.maxItems === 'number' && value.length > document.maxItems) return false
    if (document.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) return false
    if (document.items !== undefined && value.some((item) => !matchesJsonSchema(item, document.items))) return false
  }
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    if (Array.isArray(document.required) && document.required.some((key) => typeof key !== 'string' || !(key in object))) return false
    if (document.properties && typeof document.properties === 'object' && !Array.isArray(document.properties)) {
      const properties = document.properties as Record<string, unknown>
      for (const [key, childSchema] of Object.entries(properties)) if (key in object && !matchesJsonSchema(object[key], childSchema)) return false
      if (document.additionalProperties === false && Object.keys(object).some((key) => !(key in properties))) return false
      if (document.additionalProperties && typeof document.additionalProperties === 'object' && Object.keys(object).some((key) => !(key in properties) && !matchesJsonSchema(object[key], document.additionalProperties))) return false
    }
  }
  return true
}
