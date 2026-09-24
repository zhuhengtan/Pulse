#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const datasetPath = resolve(process.argv[2] ?? `${root}/evals/tasks.v1.json`)
const expectedCategories = ['code', 'research', 'file-organization']
const fail = (message) => { console.error(`EVAL_DATASET_INVALID: ${message}`); process.exitCode = 1 }
let dataset
try { dataset = JSON.parse(await readFile(datasetPath, 'utf8')) } catch (error) { fail(`cannot read JSON dataset (${error.message})`); process.exit() }
if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.tasks)) { fail('expected schemaVersion 1 and tasks array'); process.exit() }
const ids = new Set()
const counts = Object.fromEntries(expectedCategories.map((category) => [category, 0]))
for (const task of dataset.tasks) {
  if (!task || typeof task.id !== 'string' || ids.has(task.id)) fail(`missing or duplicate task id: ${task?.id ?? '(missing)'}`)
  ids.add(task.id)
  if (!expectedCategories.includes(task.category)) fail(`${task.id}: unsupported category ${task.category}`)
  else counts[task.category]++
  if (typeof task.goal !== 'string' || !task.goal.trim()) fail(`${task.id}: goal is required`)
  if (typeof task.prompt !== 'string' || !task.prompt.trim()) fail(`${task.id}: prompt is required`)
  if (!Array.isArray(task.successCriteria) || task.successCriteria.length === 0) fail(`${task.id}: successCriteria is required`)
  if (!Array.isArray(task.modelRequirements) || task.modelRequirements.length === 0) fail(`${task.id}: modelRequirements is required`)
  if (!task.sideEffects || typeof task.sideEffects.external !== 'boolean' || typeof task.sideEffects.workspaceWrites !== 'boolean' || typeof task.sideEffects.network !== 'boolean') fail(`${task.id}: sideEffects must declare external/workspaceWrites/network booleans`)
  if (!task.scoring || typeof task.scoring.method !== 'string' || !Number.isFinite(task.scoring.maxPoints) || !Array.isArray(task.scoring.checks)) fail(`${task.id}: scoring method, maxPoints, and checks are required`)
  else {
    const points = task.scoring.checks.reduce((sum, check) => sum + (Number.isFinite(check.points) && check.points > 0 ? check.points : 0), 0)
    if (Math.abs(points - task.scoring.maxPoints) > 1e-9) fail(`${task.id}: check points ${points} do not equal maxPoints ${task.scoring.maxPoints}`)
  }
  if (task.fixtures !== undefined && (!task.fixtures || typeof task.fixtures !== 'object' || Array.isArray(task.fixtures) || Object.values(task.fixtures).some((value) => typeof value !== 'string'))) fail(`${task.id}: fixtures must map workspace-relative paths to strings`)
}
if (dataset.tasks.length !== 24) fail(`expected 24 tasks, found ${dataset.tasks.length}`)
for (const category of expectedCategories) if (counts[category] !== 8) fail(`expected 8 ${category} tasks, found ${counts[category]}`)
if (!process.exitCode && !process.argv.includes('--quiet')) console.log(JSON.stringify({ valid: true, dataset: datasetPath, taskCount: dataset.tasks.length, counts }, null, 2))
