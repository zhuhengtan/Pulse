import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// GitHub validates these before assigning a runner. This narrow preflight checks
// env declarations in repository workflows; it is not a general YAML/action linter.
// https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#context-availability
const workflowContexts = new Set(['github', 'secrets', 'inputs', 'vars'])
const jobContexts = new Set([...workflowContexts, 'needs', 'strategy', 'matrix'])
const roots = /(?<![\w.])(?:github|env|vars|job|jobs|steps|runner|secrets|strategy|matrix|needs|inputs)\b/g

export function workflowEnvContextErrors(source) {
  const errors = [], lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const declaration = /^( *)env:\s*(.*)$/.exec(lines[index])
    if (!declaration) continue
    const indent = declaration[1].length
    // Existing workflows use two-space job indentation. Container, service and
    // step envs permit runner/job/env contexts; leave those to GitHub validation.
    if (indent !== 0 && indent !== 4) continue
    let body = declaration[2]
    for (let next = index + 1; next < lines.length; next++) {
      const line = lines[next]
      if (line.trim() && !line.trimStart().startsWith('#') && line.search(/\S/) <= indent) break
      if (!line.trimStart().startsWith('#')) body += '\n' + line
    }
    const allowed = indent === 0 ? workflowContexts : jobContexts
    for (const expression of body.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
      const code = expression[1].replace(/'(?:[^']|'')*'/g, "''")
      for (const match of code.matchAll(roots)) if (!allowed.has(match[0])) errors.push({ line: index + 1, scope: indent === 0 ? 'workflow.env' : 'job.env', context: match[0] })
    }
  }
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = fileURLToPath(new URL('../../.github/workflows/', import.meta.url))
  const failures = []
  for (const name of await readdir(directory)) if (/\.ya?ml$/.test(name)) {
    for (const error of workflowEnvContextErrors(await readFile(resolve(directory, name), 'utf8'))) failures.push({ file: name, ...error })
  }
  if (failures.length) throw Error('WORKFLOW_ENV_CONTEXT_UNAVAILABLE: ' + JSON.stringify(failures))
  console.log('Workflow env contexts passed (pre-runner declarations).')
}
