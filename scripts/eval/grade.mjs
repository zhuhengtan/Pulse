#!/usr/bin/env node
import { readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { runShell } from '../../packages/adapters/dist/tools/shell.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const args = process.argv.slice(2)
function value(name, fallback) { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1] }
const taskId = value('--task', undefined)
const workspace = resolve(value('--workspace', process.cwd()))
const dataset = JSON.parse(await readFile(value('--dataset', `${root}/evals/tasks.v1.json`), 'utf8'))
const tasks = taskId ? dataset.tasks.filter((task) => task.id === taskId) : dataset.tasks
if (!tasks.length) { console.error(`Unknown task: ${taskId}`); process.exit(2) }

function safePath(base, item) {
  if (isAbsolute(item)) throw new Error(`grader path must be relative: ${item}`)
  const path = resolve(base, item)
  if (relative(base, path).startsWith('..') || isAbsolute(relative(base, path))) throw new Error(`grader path escapes workspace: ${item}`)
  return path
}
async function exists(path) { try { await stat(path); return true } catch { return false } }
async function content(base, path) { try { return await readFile(safePath(base, path), 'utf8') } catch { return undefined } }
const require = createRequire(import.meta.url)
const ts = require('typescript')
async function behavior(base, item) {
  const source = safePath(base, item.path)
  const text = await content(base, item.path)
  if (text === undefined) return false
  let command, args
  if (item.scenario === 'sumFinite') {
    const js = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const test = `const vm=require('node:vm');const module={exports:{}};vm.runInNewContext(${JSON.stringify(js)}, {module,exports:module.exports});const f=module.exports.sumFinite;if(typeof f!=='function'||f([1,NaN,2,Infinity])!==3||f([])!==0)process.exit(1)`
    command = process.execPath; args = ['-e', test]
  } else if (['slug','retry','port','debounce'].includes(item.scenario)) {
    const cases = {
      slug: `if(m.slugify(' Hello, Wörld! ')!=='hello-w-rld')process.exit(1);if(m.slugify('---')!=='')process.exit(1)`,
      retry: `let n=0,d=[];const v=await m.retry(async()=>{if(++n<3)throw Error('retry');return 9},{maxAttempts:3,baseDelayMs:5,sleep:async x=>d.push(x)});if(v!==9||n!==3||d.join(',')!=='5,10')process.exit(1);let failed=false;try{await m.retry(async()=>{throw Error('x')},{maxAttempts:2,sleep:async()=>{}})}catch{failed=true}if(!failed)process.exit(1)`,
      port: `if(m.isValidPort(1)!==true||m.isValidPort(65535)!==true||m.isValidPort(0)!==false||m.isValidPort(65536)!==false)process.exit(1)`,
      debounce: `let n=0;const f=m.debounce(()=>++n,10);f();f();await new Promise(r=>setTimeout(r,25));if(n!==1)process.exit(1);const g=m.debounce(()=>++n,10);g();g.cancel();await new Promise(r=>setTimeout(r,20));if(n!==1)process.exit(1)`,
    }
    const test = `const m=await import(${JSON.stringify(pathToFileURL(source).href)});${cases[item.scenario]}`
    command = process.execPath; args = ['--input-type=module', '-e', test]
  } else if (['jsonLoad','unique'].includes(item.scenario)) {
    const body = item.scenario === 'jsonLoad'
      ? `assert m.load_json('{"ok":true}') == {"ok": True};assert m.load_json('bad',7) == 7;unittest.TestCase().assertRaises(TypeError,m.load_json,None)`
      : `assert m.unique(['a','b','a','c','b']) == ['a','b','c'];assert m.unique([]) == []`
    command = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
    args = ['-c', `import importlib.util,sys;from pathlib import Path;import unittest; p=Path(${JSON.stringify(source)});s=importlib.util.spec_from_file_location('candidate',p);m=importlib.util.module_from_spec(s);s.loader.exec_module(m);${body}`]
  } else return false
  const result = await runShell(command, args, { cwd: base, timeoutMs: 5_000, maxOutputBytes: 2_000 })
  return result.code === 0 && !result.timedOut && !result.aborted
}
function parseJson(text) { try { return JSON.parse(text) } catch { return undefined } }
function includes(text, needle, sensitive = true) { const haystack = sensitive ? text : text.toLowerCase(); const target = sensitive ? needle : needle.toLowerCase(); return haystack.includes(target) }
async function check(base, item) {
  const text = await content(base, item.path)
  const present = await exists(safePath(base, item.path))
  const insensitive = item.caseSensitive === false
  switch (item.type) {
    case 'fileExists': return present
    case 'contains': return text !== undefined && includes(text, item.needle, !insensitive)
    case 'containsAll': return text !== undefined && item.needles.every((needle) => includes(text, needle, !insensitive))
    case 'notContains': return text !== undefined && !includes(text, item.needle, !insensitive)
    case 'fileContains': return text !== undefined && includes(text, item.needle, !insensitive)
    case 'minLines': return text !== undefined && text.trim().split(/\r?\n/).length >= item.count
    case 'orderedContains': {
      if (text === undefined) return false
      let position = -1
      for (const needle of item.needles) { position = text.indexOf(needle, position + 1); if (position < 0) return false }
      return true
    }
    case 'csvHeader': return text !== undefined && text.split(/\r?\n/, 1)[0] === item.header.join(',')
    case 'jsonArray': return Array.isArray(parseJson(text ?? ''))
    case 'jsonObject': { const parsed = parseJson(text ?? ''); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) }
    case 'jsonArrayEquals': return JSON.stringify(parseJson(text ?? '')) === JSON.stringify(item.expected)
    case 'jsonArrayLength': { const parsed = parseJson(text ?? ''); return Array.isArray(parsed) && parsed.length === item.length }
    case 'jsonObjectValues': {
      const parsed = parseJson(text ?? '')
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) && Object.entries(item.expected).every(([key, val]) => parsed[key] === val)
    }
    case 'jsonlCount': return text !== undefined && text.trim().split(/\r?\n/).filter(Boolean).length === item.count && text.trim().split(/\r?\n/).filter(Boolean).every((line) => parseJson(line) !== undefined)
    case 'sourceLinks': return text !== undefined && /https:\/\/[^\s<>\]\)]+/i.test(text)
    case 'accessDate': return text !== undefined && /(?:access(?:ed| date)?|retrieved|访问日期|查阅日期)[^\r\n]{0,40}\b\d{4}-\d{2}-\d{2}\b/i.test(text)
    case 'behavior': return behavior(base, item)
    default: throw new Error(`unsupported grader check type: ${item.type}`)
  }
}
const results = []
for (const task of tasks) {
  const checks = []
  for (const item of task.scoring.checks) {
    let passed = false
    let error
    try { passed = await check(workspace, item) } catch (e) { error = e.message }
    checks.push({ type: item.type, path: item.path, passed, points: passed ? item.points : 0, maxPoints: item.points, ...(error ? { error } : {}) })
  }
  const score = checks.reduce((sum, item) => sum + item.points, 0)
  results.push({ taskId: task.id, method: task.scoring.method, score, maxPoints: task.scoring.maxPoints, checks, passed: score === task.scoring.maxPoints })
}
const output = taskId ? results[0] : { workspace, tasks: results, score: results.reduce((sum, item) => sum + item.score, 0), maxPoints: results.reduce((sum, item) => sum + item.maxPoints, 0) }
console.log(JSON.stringify(output, null, 2))
