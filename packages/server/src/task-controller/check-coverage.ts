import type { JsonValue } from '@hunterzhu/pulse-runtime'
const row = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}

/** A missing optional runner is not a failed assertion. Only a full, observed
 * unittest execution over the same named files can replace that diagnostic.
 * Explicit user runner requirements and failed/filtered tests never qualify. */
export function coversUnavailablePythonCheck(previousInput: JsonValue | undefined, previousValue: JsonValue | undefined, currentInput: JsonValue | undefined, currentValue: JsonValue | undefined, originalText: string): boolean {
  const a=row(previousInput), b=row(currentInput), old=row(previousValue), fresh=row(currentValue), before=row(old.checkReceipt), after=row(fresh.checkReceipt)
  if (/\bpytest\b/i.test(originalText) || before.schemaVersion !== 3 || after.schemaVersion !== 3) return false
  if (!/^(?:python|python3)$/.test(a.command) || a.command !== b.command || (a.cwd??'.') !== (b.cwd??'.')) return false
  if (old.code !== 1 || old.timedOut || old.aborted || !/No module named pytest\s*$/.test(old.stderr??'')) return false
  if (fresh.code !== 0 || fresh.timedOut || fresh.aborted || fresh.truncated || after.stable !== true || after.definitionChanged !== false) return false
  if (!/Ran [1-9]\d* tests? in [\s\S]*\nOK\s*$/.test(`${fresh.stdout??''}\n${fresh.stderr??''}`)) return false
  if (!Array.isArray(a.args) || !Array.isArray(b.args) || a.args[0] !== '-m' || a.args[1] !== 'pytest' || b.args[0] !== '-m' || b.args[1] !== 'unittest') return false
  const oldTargets=a.args.slice(2).filter((x: string)=>!['-v','-q'].includes(x)), targets=b.args.slice(2).filter((x: string)=>!['-v','-q'].includes(x))
  if (!oldTargets.length || !oldTargets.every((x: string)=>/^[\w./-]+\.py$/.test(x)) || !targets.length || !targets.every((x: string)=>/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(x))) return false
  const files=targets.map((x: string)=>x.replaceAll('.','/')+'.py')
  return oldTargets.every((x: string)=>files.includes(x.replace(/^\.\//,''))) && Object.keys(row(before.files)).length>0 && Object.keys(row(before.files)).every(p=>typeof row(after.files)[p]==='string')
}
