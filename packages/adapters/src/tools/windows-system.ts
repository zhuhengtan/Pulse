import { win32 } from 'node:path'

/** Host-owned system utility. Never search a project directory or PATH. */
export function windowsSystemExecutable(name: 'taskkill.exe', systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT): string | undefined {
  if (name !== 'taskkill.exe' || !systemRoot || systemRoot.split(/[/\\]/).includes('..') || !win32.isAbsolute(systemRoot) || /^[/\\]{2}/.test(systemRoot)) return undefined
  const base = win32.normalize(systemRoot)
  if (/^[/\\]{2}/.test(base)) return undefined
  const file = win32.join(base, 'System32', name)
  return win32.relative(base, file) === `System32\\${name}` ? file : undefined
}
