import { normalizeModelConfig, resolveModelReference, resolveModelSelection } from '../../packages/server/dist/model-config.js'

export function resolveEvaluationModel(config, reference) {
  if (!config || typeof config !== 'object' || typeof reference !== 'string' || !reference.trim()) throw new Error('EVAL_MODEL_REFERENCE_REQUIRED')
  const normalized = normalizeModelConfig(config)
  const selection = resolveModelSelection(normalized, resolveModelReference(normalized, reference))
  if (!selection || typeof selection.model.modelCode !== 'string' || !selection.model.modelCode.trim() || typeof selection.provider.provider !== 'string') throw new Error('EVAL_MODEL_CONFIG_INVALID')
  return { reference: selection.id, providerCode: selection.providerId, modelCode: selection.model.modelCode, profile: selection.provider, model: selection.model }
}

function boundedInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) throw new Error(`${name} must be an integer from 1 to 256`)
}
export function buildEvaluationArgs({ maxModelCalls, maxTurns }) {
  boundedInteger(maxModelCalls, '--max-model-calls')
  boundedInteger(maxTurns, '--max-turns')
  return ['--max-model-calls', String(maxModelCalls), '--max-turns', String(maxTurns)]
}

/** Parse each flag before collapsing aliases; no side effects occur on invalid input. */
export function parseEvaluationBudgets(args) {
  const value = flag => {
    const positions = args.flatMap((arg, i) => arg === flag ? [i] : [])
    if (positions.length > 1) throw new Error(`Duplicate budget flag: ${flag}`)
    if (!positions.length) return undefined
    const raw = args[positions[0] + 1]
    if (raw === undefined || raw.startsWith('--') || !raw.trim()) throw new Error(`Missing budget value: ${flag}`)
    return Number(raw)
  }
  const explicit = value('--max-model-calls'), alias = value('--max-calls'), maxTurns = value('--max-turns') ?? 24
  if (explicit !== undefined && alias !== undefined && explicit !== alias) throw new Error('Conflicting --max-calls and --max-model-calls')
  const maxModelCalls = explicit ?? alias ?? 16
  buildEvaluationArgs({ maxModelCalls, maxTurns })
  return { maxModelCalls, maxTurns }
}
