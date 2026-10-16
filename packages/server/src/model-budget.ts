import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'

const SCHEMA_VERSION = 1

const CORRUPT = 'TASK_MODEL_CALL_BUDGET_CORRUPT'
const EXHAUSTED = 'TASK_MODEL_CALL_BUDGET_EXHAUSTED'

export interface BudgetError extends Error {
  code: string
  retryable: boolean
}

function fail(code: string, message: string): BudgetError {
  const error = new Error(message) as BudgetError
  error.code = code
  error.retryable = false
  return error
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}

export interface ModelBudgetPolicy { verificationReserve?: number; maxTokens?: number; maxCostByCurrency?: Record<string, number>; unknownUsage?: 'stop' | 'allow' }
export const usageMetricNames = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'reasoningTokens', 'visibleOutputChars', 'latencyMs'] as const
export type UsageMetric = typeof usageMetricNames[number]
type UsageMetrics = Partial<Record<UsageMetric, { total: number; known: number }>>

interface State {
  truncationEvents?: number | undefined
  metrics?: UsageMetrics | undefined
  usageReceipts?: string[] | undefined
  policy?: ModelBudgetPolicy | undefined
  purposes?: Record<string, number> | undefined
  reportedUsage?: number | undefined
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  tokens?: number | undefined
  costs?: Record<string, number> | undefined
  unknown?: number | undefined
  limit: number
  used: number
}

function parseState(raw: string): State {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    throw fail(CORRUPT, 'Model budget file is not valid JSON.')
  }
  if (typeof data !== 'object' || data === null)
    throw fail(CORRUPT, 'Model budget file is not an object.')
  const record = data as Record<string, unknown>
  if (record.schemaVersion !== SCHEMA_VERSION)
    throw fail(CORRUPT, 'Unsupported model budget schemaVersion.')
  if (!isCount(record.limit) || !isCount(record.used))
    throw fail(CORRUPT, 'Model budget file has invalid counters.')
  for (const key of ['reportedUsage', 'inputTokens', 'outputTokens', 'tokens', 'unknown', 'truncationEvents']) if (record[key] !== undefined && !isCount(record[key])) throw fail(CORRUPT, `Invalid budget field: ${key}`)
  if (record.purposes !== undefined && (typeof record.purposes !== 'object' || record.purposes === null || Object.values(record.purposes).some(n => !isCount(n)))) throw fail(CORRUPT, 'Invalid budget purpose counters.')
  if (record.costs !== undefined && (typeof record.costs !== 'object' || record.costs === null || Object.values(record.costs).some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0))) throw fail(CORRUPT, 'Invalid budget costs.')
  if (record.metrics !== undefined && (typeof record.metrics !== 'object' || record.metrics === null || Object.entries(record.metrics).some(([key, value]) => !usageMetricNames.includes(key as UsageMetric) || !value || typeof value !== 'object' || typeof (value as any).total !== 'number' || !Number.isFinite((value as any).total) || (value as any).total < 0 || !isCount((value as any).known)))) throw fail(CORRUPT, 'Invalid usage metrics.')
  if (record.usageReceipts !== undefined && (!Array.isArray(record.usageReceipts) || record.usageReceipts.some(id => typeof id !== 'string'))) throw fail(CORRUPT, 'Invalid usage receipts.')
  return { truncationEvents: record.truncationEvents as number | undefined, limit: record.limit, used: record.used, metrics: record.metrics as UsageMetrics | undefined, usageReceipts: record.usageReceipts as string[] | undefined, policy: record.policy as ModelBudgetPolicy | undefined, purposes: record.purposes as Record<string, number> | undefined, reportedUsage: record.reportedUsage as number | undefined, inputTokens: record.inputTokens as number | undefined, outputTokens: record.outputTokens as number | undefined, tokens: record.tokens as number | undefined, costs: record.costs as Record<string, number> | undefined, unknown: record.unknown as number | undefined }
}

/** One instance per running task; LocalHost holds the conversation lock. */
export class ModelAttemptBudget {
  private state: State
  private usedCount: number
  private limitCount: number
  private queue: Promise<void> = Promise.resolve()

  private constructor(
    private readonly filePath: string,
    limit: number,
    used: number,
    state?: State,
  ) {
    this.state = state ?? { limit, used }
    this.limitCount = limit
    this.usedCount = used
  }

  get used(): number {
    return this.usedCount
  }

  get limit(): number {
    return this.limitCount
  }

  static async open(
    filePath: string,
    limit: number,
    initialUsed = 0,
    policy?: ModelBudgetPolicy,
  ): Promise<ModelAttemptBudget> {
    if (!isCount(limit))
      throw fail(CORRUPT, 'Model budget limit must be a non-negative integer.')
    if (!isCount(initialUsed))
      throw fail(CORRUPT, 'Model budget initialUsed must be a non-negative integer.')
    if (policy) {
      if (policy.verificationReserve !== undefined && !isCount(policy.verificationReserve) || policy.maxTokens !== undefined && !isCount(policy.maxTokens) || Object.values(policy.maxCostByCurrency ?? {}).some(n => !Number.isFinite(n) || n < 0) || policy.unknownUsage !== undefined && !['stop', 'allow'].includes(policy.unknownUsage)) throw fail(CORRUPT, 'Invalid model budget policy.')
    }
    let state: State | undefined
    try {
      state = parseState(await fs.readFile(filePath, 'utf8'))
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    if (state !== undefined)
      return new ModelAttemptBudget(filePath, state.limit, state.used, state)
    const budget = new ModelAttemptBudget(filePath, limit, initialUsed, { limit, used: initialUsed, ...(policy ? { policy: structuredClone(policy) } : {}) })
    await budget.persist(budget.state)
    return budget
  }

  async reserve(purpose = 'work'): Promise<void> {
    const run = this.queue.then(() => this.reserveOnce(purpose))
    this.queue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /** Host scheduling consults the same durable admission policy as dispatch. */
  schedulingView(): { limit: number; used: number; workAllowed: boolean; verificationAllowed: boolean; finalAllowed: boolean; reason?: string } {
    const allowed = (purpose: string) => { try { this.assertAdmission(purpose); return true } catch { return false } }
    let reason: string | undefined
    try { this.assertAdmission('work') } catch (error) { reason = error instanceof Error ? error.message : String(error) }
    return { limit: this.limit, used: this.used, workAllowed: allowed('work'), verificationAllowed: allowed('verification'), finalAllowed: allowed('final-verification'), ...(reason ? { reason } : {}) }
  }

  private assertAdmission(purpose: string): void {
    if (this.usedCount >= this.limitCount)
      throw fail(EXHAUSTED, 'Model call budget exhausted.')
    const policy = this.state.policy ?? {}
    const reserved = Math.min(policy.verificationReserve ?? 0, Math.max(0, this.limit - 1))
    const protectedCalls = purpose === 'final-verification' ? 0 : purpose === 'verification' ? Math.min(1, reserved) : reserved
    if (this.limit - this.used <= protectedCalls) throw fail(EXHAUSTED, 'Model calls reserved for verification; checkpoint retained.')
    if (policy.maxTokens !== undefined && (this.state.tokens ?? 0) >= policy.maxTokens) throw fail(EXHAUSTED, 'Model token budget exhausted.')
    for (const [currency, limit] of Object.entries(policy.maxCostByCurrency ?? {})) if ((this.state.costs?.[currency] ?? 0) >= limit) throw fail(EXHAUSTED, `Model cost budget exhausted (${currency}).`)
    if ((policy.maxTokens !== undefined || Object.keys(policy.maxCostByCurrency ?? {}).length) && (this.state.unknown ?? 0) > 0 && policy.unknownUsage !== 'allow') throw fail(EXHAUSTED, 'Usage or price unknown under a configured budget; explicit allow policy is required to continue.')
  }

  private async reserveOnce(purpose: string): Promise<void> {
    this.assertAdmission(purpose)
    const next: State = { ...this.state, limit: this.limitCount, used: this.usedCount + 1, purposes: { ...this.state.purposes, [purpose]: (this.state.purposes?.[purpose] ?? 0) + 1 }, unknown: (this.state.unknown ?? 0) + 1 }
    await this.persist(next)
    this.state = next
    this.usedCount = next.used
  }

  get accounting(): Readonly<State> { return structuredClone(this.state) }
  async recordUsage(usage?: Partial<Record<UsageMetric, number>> & { outputTruncated?: boolean; costs?: Array<{ currency: string; amount: number }>; cost?: { currency: string; amount: number } }, receiptId?: string): Promise<void> {
    const run = this.queue.then(async () => {
      if (receiptId && this.state.usageReceipts?.includes(receiptId)) return
      if (usage?.cost) usage = { ...usage, costs: [...(usage.costs ?? []), usage.cost] }
      const tokenKnown = typeof usage?.inputTokens === 'number' && typeof usage?.outputTokens === 'number'
      const costKnown = Object.keys(this.state.policy?.maxCostByCurrency ?? {}).every(currency => usage?.costs?.some(c => c.currency === currency))
      const costs = { ...this.state.costs }
      for (const cost of usage?.costs ?? []) costs[cost.currency] = (costs[cost.currency] ?? 0) + cost.amount
      const next = { ...this.state, ...(usage?.outputTruncated === undefined ? {} : { truncationEvents: (this.state.truncationEvents ?? 0) + (usage.outputTruncated ? 1 : 0) }), costs, reportedUsage: (this.state.reportedUsage ?? 0) + (tokenKnown ? 1 : 0), inputTokens: (this.state.inputTokens ?? 0) + (typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0), outputTokens: (this.state.outputTokens ?? 0) + (typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0), tokens: (this.state.tokens ?? 0) + (typeof usage?.inputTokens === 'number' ? usage.inputTokens : 0) + (typeof usage?.outputTokens === 'number' ? usage.outputTokens : 0), unknown: Math.max(0, (this.state.unknown ?? 0) - (tokenKnown && costKnown ? 1 : 0)) }
      const metrics = { ...this.state.metrics }
      for (const key of usageMetricNames) {
        const value = usage?.[key]
        if (value === undefined) continue
        if (!Number.isFinite(value) || value < 0) throw fail(CORRUPT, `Invalid reported metric: ${key}`)
        const prior = metrics[key] ?? { total: key === 'inputTokens' || key === 'outputTokens' ? this.state[key] ?? 0 : 0, known: key === 'inputTokens' || key === 'outputTokens' ? this.state.reportedUsage ?? 0 : 0 }
        metrics[key] = { total: prior.total + value, known: prior.known + 1 }
      }
      Object.assign(next, { metrics, ...(receiptId ? { usageReceipts: [...(this.state.usageReceipts ?? []), receiptId] } : {}) })
      await this.persist(next); this.state = next
    }); this.queue = run.catch(() => undefined); return run
  }

  private async persist(state: State): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const temp = `${this.filePath}.${randomUUID()}.tmp`
    const body = JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      ...state,
    })
    try {
      const handle = await fs.open(temp, 'wx', 0o600)
      try { await handle.writeFile(body); await handle.sync() } finally { await handle.close() }
      await fs.rename(temp, this.filePath)
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
  }
}
