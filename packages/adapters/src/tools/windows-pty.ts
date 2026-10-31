import { win32 } from 'node:path'

/** Host-only selection. Neither modulePath nor the bridge is a model tool input. */
export interface WindowsPty { modulePath: string; scope: string }

/** Preserve the verified SRT broker and every policy/env argument. Replace only
 * its inner target: the pipe-based PowerShell wrapper cannot provide a TTY. */
export function windowsPtyCommand(argv: string[], node: string, bridge: string, pty: WindowsPty, command: string, args: string[]): string[] {
  const separator = argv.indexOf('--')
  if (separator < 2 || separator + 1 >= argv.length) throw new Error('INVALID_WINDOWS_SANDBOX_COMMAND')
  if (![node, bridge, pty.modulePath, command].every(value => win32.isAbsolute(value) && !value.includes('\0')) || args.some(value => value.includes('\0')) || !/^[0-9a-f]{32}$/.test(pty.scope)) throw new Error('INVALID_WINDOWS_PTY_COMMAND')
  const payload = Buffer.from(JSON.stringify({ modulePath: pty.modulePath, command, args, scope: pty.scope }), 'utf8').toString('base64')
  const result = [...argv.slice(0, separator + 1), node, bridge, payload]
  if (result.reduce((length, argument) => length + argument.length + 3, 0) > 30_000) throw new Error('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
  return result
}
