import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const digest = value => createHash('sha256').update(value).digest('hex')
const json = async path => { try { return JSON.parse(await readFile(path, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
const directories = async path => { try { return (await readdir(path, { withFileTypes: true })).filter(x => x.isDirectory()).map(x => x.name).sort() } catch (error) { if (error.code === 'ENOENT') return []; throw error } }
export function redact(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s]+/g, '[URL]').replace(/(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}/g, '[CREDENTIAL]')
    .replace(/((?:api[_-]?key|authorization|token|password|secret)\s*["']?\s*[:=]\s*)[^\s,;]+/gi, '$1[REDACTED]')
}
export async function auditHistory(roots) {
  const records = new Map(), conflicts = []
  for (const root of roots.map(root => resolve(root))) for (const conversation of await directories(join(root, 'conversations'))) {
    for (const run of await directories(join(root, 'conversations', conversation, 'runs'))) {
      const source = join(root, 'conversations', conversation, 'runs', run)
      const input = await json(join(source, 'input.json'))
      if (!input) continue
      const [outcome, task, controller, operations, runtime, usage, receipts] = await Promise.all(['outcome.json', 'task-outcome.json', 'task-controller.json', 'operations.json', 'runtime.json', 'usage.json', 'interaction-receipts.json'].map(f => json(join(source, f))))
      const errors = (controller?.tasks ?? []).filter(t => t.status === 'blocked' && t.attempts > 0).map(t => ({ stage: t.id, reason: redact(t.note).slice(0, 500) }))
      const code = outcome?.error?.code
      const state = runtime?.state?.state ?? {}
      const effects = Array.isArray(state.effects) ? state.effects.map(([,effect])=>effect) : []
      const timeline = effects.filter(e=>e.kind==='tool'||e.kind==='human').map(e=>({effectId:e.id,laneId:e.ownerLaneId,kind:e.kind,tool:e.input?.name??null,status:e.status??e.outcome?.status??null,errorCode:e.outcome?.error?.code??null,resultRef:e.outcome?.resultRef??null,approvalDigest:e.kind==='human'?e.input?.digest??null:undefined,requestedTools:e.kind==='human'?(e.input?.tools??[]).map(t=>t.toolName??t.name):undefined,source:join(source,'runtime.json')}))
      const classification = !outcome ? 'unsettled' : outcome.status === 'cancelled' ? 'cancelled' : task?.status === 'accepted' ? 'reported-accepted-unverified' : /APPROVAL|PERMISSION|SANDBOX|PROVIDER|CAPABILITY/.test(code ?? '') ? 'environment-or-authorization' : code ? 'runtime-failure' : task?.status === 'incomplete' || task?.status === 'unverifiable' ? 'incomplete-or-unverifiable' : 'unclassified'
      const record = { conversation, run, sources: [source], createdAt: input.createdAt, mode: input.assistantChat ? 'assistant' : input.taskController ? 'controller' : 'legacy', controllerVersion: input.controllerVersion ?? null, provider: input.provider, model: input.model ?? null, approvalMode: input.approvalMode, capabilitySurface: input.capabilitySurface ?? null,
        build: runtime?.compatibility?.fingerprints?.build ?? null, requirement: { sha256: digest(input.goal ?? ''), excerpt: redact(input.goal).slice(0, 300), source: join(source, 'input.json') }, runtimeStatus: outcome?.status ?? null, taskStatus: task?.status ?? null, classification, code: code ?? null, blockers: errors,
        operations: (operations?.operations ?? []).map(o => ({ tool: o.tool, status: o.status, resultRef: o.resultRef, path: redact(o.path), exitCode: o.exitCode })),
        criteria: (task?.criteria ?? []).map(c => ({ criterionId: c.criterionId, status: c.status, evidenceRefs: c.evidenceRefs })),
        registeredTools: Object.keys(runtime?.compatibility?.toolVersions??{}), timeline,
        humanInteractions: timeline.filter(e=>e.kind==='human').length,
        modelCalls: usage?.budget?.used ?? outcome?.usage?.budget?.used ?? null, interactionReceiptCount: Array.isArray(receipts) ? receipts.length : Array.isArray(receipts?.receipts) ? receipts.receipts.length : null,
      }
      const key = `${conversation}/${run}`, previous = records.get(key)
      if (previous) {
        if (previous.requirement.sha256 !== record.requirement.sha256 || previous.runtimeStatus !== record.runtimeStatus || previous.taskStatus !== record.taskStatus) conflicts.push({ key, sources: [...previous.sources, source] })
        previous.sources.push(source)
      } else records.set(key, record)
    }
  }
  const rows = [...records.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), readOnlySources: true, qualityBaselineCreated: false, note: 'Reported accepted is not independent acceptance. Historical versions, tests and cancellations must not be pooled into a current success rate.', conflicts, counts: Object.fromEntries([...new Set(rows.map(r => r.classification))].map(k => [k, rows.filter(r => r.classification === k).length])), records: rows }
}
export async function auditEvaluations(root) {
  const attempts=[]
  for(const scenario of await directories(root)) for(const round of await directories(join(root,scenario,'runs'))) {
    const source=join(root,scenario,'runs',round,'result.json'),result=await json(source)
    if(!result)continue
    attempts.push({source,scenario,round,model:result.model??null,runtimeStatus:result.runtimeStatus,taskStatus:result.taskOutcomeStatus,reportedPassed:result.passed,externalGraderPassed:result.verification?.passed??null,modelCalls:result.totalModelCalls??result.usage?.modelCalls??null,simulatedApprovals:result.evaluatorApprovals?.length??null,interruptedRuns:result.interruptedRuns?.length??0})
  }
  return {selection:'all recorded attempts; no best-of-round filtering',attempts}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), roots = []; let out, evaluations
  for (let i = 0; i < args.length; i++) { if (args[i] === '--data' && args[i + 1]) roots.push(args[++i]); else if (args[i] === '--out' && args[i + 1]) out = resolve(args[++i]); else if(args[i]==='--evaluations'&&args[i+1])evaluations=resolve(args[++i]); else throw Error(`Unknown/missing argument: ${args[i]}`) }
  if (!out || !roots.length) throw Error('Usage: audit-history.mjs --data <data-root> [--data <data-root>] --out <new-output-directory>')
  if (roots.some(root => out === resolve(root) || out.startsWith(resolve(root) + '/'))) throw Error('AUDIT_OUTPUT_MUST_NOT_BE_IN_SOURCE')
  await mkdir(out, { recursive: false })
  const report = await auditHistory(roots)
  if(evaluations)report.evaluations=await auditEvaluations(evaluations)
  await writeFile(join(out, 'history.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ records: report.records.length, conflicts: report.conflicts.length, counts: report.counts, report: join(out, 'history.json') }))
}
