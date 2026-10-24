import type { JsonValue } from '@hunterzhu/pulse-runtime'

/** Resolve an explicitly window-scoped request before proposing a display capture.
 * This is a parameter diagnostic, never an approval or a target selector. */
export function assertWindowObservationScope(request: string, name: string, input: JsonValue): void {
  if (name !== 'computer.observe') return
  const text = request.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|"[^"\n]*"/g, '')
  if (!/(?:窗口|\bwindows?\b)/i.test(text) || /(?:全屏|整屏|整个屏幕|\b(?:entire|whole|full)[ -](?:screen|display)\b)/i.test(text)) return
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  if (typeof args.windowId === 'string' && args.windowId.trim()) return
  const message = 'This request names a window. Missing windowId would capture the selected target or entire display. Enumerate computer.windows and supply the matching windowId for read-only capture; do not select or activate a window unless authorized. If no matching window exists, report the blocker.'
  throw Object.assign(new Error(`INVALID_TOOL_INPUT: ${message}`), { code: 'INVALID_TOOL_INPUT', retryable: false, details: { tool: name, diagnostics: [{ path: 'windowId', constraint: 'explicit window observation target', message }] } })
}

/** Only direct prohibitions in the caller-owned request. Never scan tool/file evidence. */
export function assertExplicitToolRestriction(request: string, name: string, input: JsonValue): void {
  // Quoted/code examples are data; this deliberately does not interpret them as policy.
  const text = request.replace(/```[\s\S]*?```|“[^”]*”|「[^」]*」|"[^"\n]*"/g, '').replace(/`([^`]+)`/g, '$1')
  const clauses = text.split(/[。！？;；\n]/).flatMap(s => {
    const start = s.search(/不要|不得|禁止|不能|\b(?:do not|don't|never)\b/i)
    if (start < 0) return []
    const negative = s.slice(start).split(/(?:但是|不过|然而|然后|随后|但允许|但可以|请|\b(?:but|then|instead|unless|except)\b)/i)[0]!
    // Conditional exceptions require contextual review, not a blanket prohibition.
    return /除.+(?:外|以外)|仅可|except|unless/i.test(s) ? [] : [negative]
  })
  const denied = (pattern: RegExp) => clauses.some(s => pattern.test(s))
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const command = String(args.command ?? '').replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? ''
  let reason: string | undefined
  if (name === 'shell.exec' && denied(/(?:不要|不得|禁止|不能)(?:运行|执行|调用)(?:任何)?(?:命令|shell)|\b(?:do not|don't|never)\s+(?:run|execute)\s+(?:any\s+)?(?:shell\s+)?commands?\b/i)) reason = 'Command execution is explicitly prohibited.'
  if (name === 'shell.exec' && denied(/(?:执行|运行)(?:系统)?脚本|\b(?:run|execute)\s+(?:system\s+)?scripts?\b/i) && (/^(?:env|command|sudo|xcrun|osascript|powershell(?:\.exe)?|pwsh(?:\.exe)?|cmd(?:\.exe)?|bash|zsh|sh|fish|python[\d.]*|node(?:\.exe)?|ruby|perl|wscript(?:\.exe)?|cscript(?:\.exe)?)$/.test(command) || /\.(?:sh|command|ps1|vbs|js|mjs|cjs|py|rb|pl)$/i.test(command))) reason = 'Script execution is explicitly prohibited.'
  if (name === 'shell.exec' && denied(/安装(?:软件|工具)|\binstall\s+(?:software|tools?|packages?)\b/i)) {
    const argv = Array.isArray(args.args) ? args.args.map(String) : []
    if (/^(?:brew|apt|apt-get|yum|dnf|pip[\d.]*|npm|pnpm|yarn|bun|uv|cargo|winget|choco|npx|uvx)$/.test(command) && (argv.some(a => /^(?:install|add|i|dlx|x|tool)$/.test(a)) || /^(?:npx|uvx)$/.test(command))) reason = 'Software installation is explicitly prohibited.'
  }
  if (/^(?:computer|browser)\.act$/.test(name)) {
    const action = args.action && typeof args.action === 'object' && !Array.isArray(args.action) ? args.action : {}
    const clicks = ['click','drag'].includes(String(action.type)) || action.type === 'element' && action.operation === 'click'
    const types = ['type','key'].includes(String(action.type)) || action.type === 'element' && action.operation !== 'click'
    if (denied(/交互|\binteract\b/i) || clicks && denied(/点击|\bclick\b/i) || types && denied(/键入|输入|\btype\b/i)) reason = 'This UI interaction is explicitly prohibited; read-only observations remain available.'
  }
  if (name === 'computer.selectWindow' && denied(/(?:切换|置前|选择)(?:任何|其他)?(?:窗口|应用)|\b(?:switch|focus|select)\s+(?:(?:any|other)\s+)?(?:windows?|apps?|applications?)\b/i)) reason = 'Window selection is explicitly prohibited.'
  if (reason) throw Object.assign(new Error(`USER_TOOL_RESTRICTION: ${reason} Choose an allowed method or report the authorization blocker.`), { code: 'USER_TOOL_RESTRICTION', retryable: false })
}
