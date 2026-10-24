import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import type { CheckReceipt } from '../check-receipt.js'

export interface CandidateScriptCoverage {
  schemaVersion: 1
  definition: string
  scriptHash: string
  files: string[]
}

/** Bounded proof for a new Node test entrypoint, never for caller-owned scripts. */
export async function candidateScriptCoverage(root: string, receipt: CheckReceipt, definition: string): Promise<CandidateScriptCoverage | undefined> {
  const match = /^(.*\bpackage\.json)#scripts:([A-Za-z0-9:_-]+)$/.exec(definition)
  if (!match || !/^(?:npm|pnpm|yarn|bun)$/.test(receipt.command)) return
  const packagePath = match[1]!, name = match[2]!
  const selected = receipt.args.filter(arg => !arg.startsWith('-'))
  if ((selected[0] === 'run' ? selected[1] : selected[0]) !== name) return
  const text = await readFile(resolve(root, packagePath), 'utf8')
  if (createHash('sha256').update(text).digest('hex') !== receipt.files[packagePath]) return
  const script: unknown = JSON.parse(text).scripts?.[name]
  if (typeof script !== 'string' || script.length > 2048) return
  const tokens = script.trim().split(/\s+/)
  if (tokens[0] !== 'node' || tokens[1] !== '--test' || tokens.length < 3) return
  const selectors = tokens.slice(2)
  if (selectors.some(token => !/^(?:\.\/)?[A-Za-z0-9_./*?-]+$/.test(token) || token.startsWith('-') || token.startsWith('/') || token.split('/').includes('..') || token.includes('**'))) return
  const prefix = dirname(packagePath).replaceAll('\\', '/')
  const base = prefix === '.' ? '' : prefix + '/'
  const tests = Object.keys(receipt.definitions).filter(path => /\.[cm]?js$/.test(path) && /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?js$/.test(path))
  if (!tests.length || tests.length > 1024 || tests.some(path => !path.startsWith(base))) return
  const patterns = selectors.map(selector => {
    const normalized = selector.replace(/^\.\//, '')
    const pattern = normalized.split('').map(char => char === '*' ? '[^/]*' : char === '?' ? '[^/]' : /[.\[\]{}()+^$|\\]/.test(char) ? '\\' + char : char).join('')
    return new RegExp('^' + pattern + (normalized.endsWith('/') ? '.+' : '') + '$')
  })
  if (tests.some(path => !patterns.some(pattern => pattern.test(path.slice(base.length))))) return
  return { schemaVersion: 1, definition, scriptHash: createHash('sha256').update(script).digest('hex'), files: tests.sort() }
}
