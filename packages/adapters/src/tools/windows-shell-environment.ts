/** Override only Pulse's execution settings across SRT's fresh-user logon.
 * Native --env arguments bypass cmd.exe parsing and its smaller text limit. */
export function windowsShellEnvironment(argv: string[], overrides: Record<string, string | undefined>): string[] {
  const separator = argv.indexOf('--')
  if (separator < 2 || separator + 1 >= argv.length) throw new Error('INVALID_WINDOWS_SANDBOX_COMMAND')
  const values = new Map<string, [string, string]>()
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes('\0')) throw new Error('INVALID_SHELL_ENVIRONMENT')
    values.set(key.toUpperCase(), [key, value])
  }
  const result: string[] = []
  for (let index = 0; index < separator; index++) {
    const argument = argv[index]!
    if (argument !== '--env') { result.push(argument); continue }
    const entry = argv[++index]
    const equals = entry?.indexOf('=') ?? -1
    if (index >= separator || equals < 1) throw new Error('INVALID_WINDOWS_SANDBOX_COMMAND')
    if (!values.has(entry!.slice(0, equals).toUpperCase())) result.push('--env', entry!)
  }
  for (const [key, value] of values.values()) result.push('--env', `${key}=${value}`)
  result.push(...argv.slice(separator))
  if (result.reduce((length, argument) => length + argument.length + 3, 0) > 30_000) throw new Error('INVALID_SHELL_ARGUMENTS_TOO_LARGE')
  return result
}
