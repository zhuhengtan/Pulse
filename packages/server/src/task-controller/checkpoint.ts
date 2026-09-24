import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, open, realpath } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'
import type { PulseRuntime, JsonValue } from '@hunterzhu/pulse-runtime'
import { controllerFromGlobal, type TaskControllerState } from './state.js'
const exec = promisify(execFile)
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
/** A bounded serialized window. Offsets are UTF-16 positions, always at code-point boundaries. */
export function textWindow(text: string, offset = 0): { content: string; nextOffset: number | null } {
  let content = ''; let end = offset
  for (const char of text.slice(offset)) {
    if (Buffer.byteLength(JSON.stringify(content + char)) > 2800) break
    content += char; end += char.length
  }
  return { content, nextOffset: end < text.length ? end : null }
}
async function boundedHash(path: string): Promise<string | undefined> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > 8_000_000) return undefined
    const hash = createHash('sha256'); const buffer = Buffer.alloc(64 * 1024); let bytes = 0
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null)
      if (!bytesRead) break
      bytes += bytesRead
      if (bytes > 8_000_000) return undefined
      hash.update(buffer.subarray(0, bytesRead))
    }
    const after = await file.stat()
    return before.size === bytes && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs ? hash.digest('hex') : undefined
  } finally { await file.close() }
}
export interface WorkspaceStamp { available: boolean; files: Record<string, string>; digest?: string }
export async function workspaceStamp(root: string): Promise<WorkspaceStamp> {
  try {
    const { stdout } = await exec('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, maxBuffer: 1_000_000, timeout: 5000 })
    const paths = [...new Set(stdout.split('\0').filter(Boolean))].sort()
    if (paths.length > 5000) return { available: false, files: {} }
    const realRoot = await realpath(root)
    const files: Record<string, string> = {}; let bytes = 0
    for (const path of paths) {
      const target = resolve(root, path)
      const rel = relative(root, target)
      if (isAbsolute(rel) || rel.startsWith('..')) return { available: false, files: {} }
      const info = await lstat(target).catch(() => undefined)
      if (!info) { files[path] = 'missing'; continue }
      if (!info.isFile() || info.isSymbolicLink()) return { available: false, files: {} }
      bytes += info.size
      if (info.size > 8_000_000 || bytes > 64_000_000) return { available: false, files: {} }
      const physical = await realpath(target); const physicalRel = relative(realRoot, physical)
      if (isAbsolute(physicalRel) || physicalRel.startsWith('..')) return { available: false, files: {} }
      const hash = await boundedHash(physical)
      if (!hash) return { available: false, files: {} }
      files[path] = hash
    }
    return { available: true, files, digest: digest(JSON.stringify(files)) }
  } catch { return { available: false, files: {} } }
}
export interface Checkpoint {
  schemaVersion: 1; sourceRunId: string; objective: string; controller: TaskControllerState
  stamp: WorkspaceStamp; fileHashes: Record<string, string>; reusableIds: string[]
  evidence: Record<string, JsonValue[]>
}
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
async function fileHash(root: string, path: string): Promise<string | undefined> {
  try {
    const realRoot = await realpath(root); const target = await realpath(resolve(root, path)); const rel = relative(realRoot, target)
    if (isAbsolute(rel) || rel.startsWith('..')) return undefined
    const info = await lstat(target)
    if (!info.isFile() || info.size > 8_000_000) return undefined
    return await boundedHash(target)
  } catch { return undefined }
}
export async function createCheckpoint(runtime: PulseRuntime, root: string, runId: string, global: JsonValue, prior?: Checkpoint): Promise<Checkpoint | undefined> {
  const controller = controllerFromGlobal(global); const objective = object(object(global).taskRecord).objective
  if (!controller || typeof objective !== 'string') return undefined
  const inherited = prior ? await validateCheckpoint(root, prior, objective) : undefined
  const stamp = await workspaceStamp(root); const fileHashes: Record<string,string> = {}; const evidence: Record<string,JsonValue[]> = {}; const reusableIds: string[] = []
  for (const task of controller.tasks) {
    if (task.status !== 'passed' || !task.evidenceRefs.length) continue
    let valid = true; const values: JsonValue[] = []
    for (const ref of task.evidenceRefs) {
      const result = runtime.state.results.get(ref); const effect = result?.producer?.kind === 'effect' ? runtime.state.effects.get(result.producer.id) : undefined
      const input = object(effect?.input); const value = object(result?.value)
      if (input.name === 'task.recall' && inherited?.reusableIds.includes(task.id) && result?.privacy === 'public' && !result.privacyTaints?.length && effect?.outcome?.status === 'succeeded' && value.valid === true && Array.isArray(value.reusableIds) && value.reusableIds.includes(task.id) && !object(input.arguments).stageId) {
        values.push(...inherited.evidence[task.id]!); Object.assign(fileHashes, inherited.fileHashes); continue
      }
      // External calls and commands may depend on state outside the workspace.
      // They are never automatically cached as fresh checks.
      if (result?.privacy !== 'public' || result.privacyTaints?.length || effect?.outcome?.status !== 'succeeded' || !['fs.read','fs.write','fs.apply_patch'].includes(input.name)) { valid = false; break }
      if (['fs.read','fs.write','fs.apply_patch'].includes(input.name)) {
        const path = value.path
        if (typeof path !== 'string' || typeof value.hash !== 'string' || await fileHash(root, path) !== value.hash) { valid = false; break }
        fileHashes[path] = value.hash
      }
      values.push({ sourceRef: ref, tool: input.name, result: result?.summary ?? result?.value ?? null })
    }
    if (valid && stamp.available && Buffer.byteLength(JSON.stringify(values)) <= 32_000) { reusableIds.push(task.id); evidence[task.id] = values }
  }
  return { schemaVersion: 1, sourceRunId: runId, objective, controller, stamp, fileHashes, reusableIds, evidence }
}
export function checkpointReceipt(checkpoint: Checkpoint) {
  const stages: Array<{ id: string; goal: string; check: string; note: string; evidence: string }> = []
  for (const task of checkpoint.controller.tasks) {
    if (!checkpoint.reusableIds.includes(task.id)) continue
    const item = { id: task.id, goal: task.goal, check: task.check, note: task.note ?? '', evidence: JSON.stringify(checkpoint.evidence[task.id]) }
    if (Buffer.byteLength(JSON.stringify([...stages, item])) <= 2800) stages.push(item)
  }
  return { valid: true, sourceRunId: checkpoint.sourceRunId, reusableIds: stages.map((stage) => stage.id), stages, verification: 'Workspace and referenced hashes match. These are historical filesystem facts, not fresh shell or external checks.' }
}
export async function validateCheckpoint(root: string, checkpoint: Checkpoint, objective: string): Promise<Checkpoint | undefined> {
  try {
    if (!checkpoint || checkpoint.schemaVersion !== 1 || checkpoint.objective !== objective || !checkpoint.stamp?.available || typeof checkpoint.sourceRunId !== 'string') return undefined
    const controller = controllerFromGlobal({ taskController: JSON.parse(JSON.stringify(checkpoint.controller)) })
    if (!controller || !Array.isArray(checkpoint.reusableIds) || !checkpoint.fileHashes || !checkpoint.evidence) return undefined
    if (checkpoint.reusableIds.some((id) => typeof id !== 'string' || !controller.tasks.some((task) => task.id === id && task.status === 'passed') || !Array.isArray(checkpoint.evidence[id]))) return undefined
    const current = await workspaceStamp(root)
    if (!current.available || current.digest !== checkpoint.stamp.digest) return undefined
    for (const [path, hash] of Object.entries(checkpoint.fileHashes)) if (typeof hash !== 'string' || await fileHash(root, path) !== hash) return undefined
    return checkpoint
  } catch { return undefined }
}

export function operationAudit(runtime: PulseRuntime, laneId?: string): JsonValue {
  const operations = [...runtime.state.effects.values()].filter((effect) => effect.kind === 'tool' && (laneId === undefined || effect.ownerLaneId === laneId)).map((effect) => {
    const input = object(effect.input); const args = object(input.arguments)
    const result = effect.outcome?.resultRef ? runtime.state.results.get(effect.outcome.resultRef) : undefined
    const value = object(result?.value)
    return { effectId: effect.id, tool: String(input.name ?? 'unknown'), status: effect.outcome?.status ?? effect.state,
      ...(typeof args.path === 'string' ? { path: args.path } : {}),
      ...(input.name === 'shell.exec' ? { command: String(args.command ?? ''), opaqueSideEffects: true, exitCode: typeof value.code === 'number' ? value.code : null } : {}),
      ...(effect.outcome?.resultRef ? { resultRef: effect.outcome.resultRef } : {}) }
  })
  return { scope: 'Only operations submitted by this Runtime. Git dirty files may predate this task or belong to other processes. Shell effects require reviewing their result; this is not proof of absence of all external changes.', operations }
}
