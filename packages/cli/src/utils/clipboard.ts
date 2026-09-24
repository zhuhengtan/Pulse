import { spawn } from 'node:child_process'
import { stripTerminalControls } from './ansi.js'

interface ClipboardCommand { file: string; args: string[] }

export function isCopyShortcut(input: string, key: { ctrl?: boolean; meta?: boolean }): boolean {
  const value = input.toLowerCase()
  return (key.meta === true && value === 'c') || (key.ctrl === true && (value === 'c' || input === '\u0003'))
}

export function clipboardCommands(platform = process.platform): ClipboardCommand[] {
  if (platform === 'darwin') return [{ file: 'pbcopy', args: [] }]
  if (platform === 'win32') return [{ file: 'clip.exe', args: [] }]
  if (platform === 'linux') return [{ file: 'wl-copy', args: [] }, { file: 'xclip', args: ['-selection', 'clipboard'] }]
  return []
}

/** Remove characters that look blank but become troublesome when pasted. */
export function sanitizeClipboardText(text: string): string {
  return stripTerminalControls(text)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00A0\u202F]/g, ' ')
    .replace(/[\u00AD\u200B\u2060\uFEFF]/g, '')
}

/** Copy the complete plain-text payload through the host OS clipboard utility. */
export async function copyToClipboard(text: string): Promise<void> {
  const cleanText = sanitizeClipboardText(text)
  const commands = clipboardCommands()
  if (!commands.length) throw new Error('CLIPBOARD_UNSUPPORTED')
  let lastError: unknown
  for (const command of commands) {
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(command.file, command.args, { stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (chunk: string) => { stderr += chunk })
        child.once('error', reject)
        child.once('close', (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `${command.file} exited with ${code}`)))
        child.stdin.once('error', reject)
        child.stdin.end(cleanText)
      })
      return
    } catch (error) { lastError = error }
  }
  throw Object.assign(new Error('CLIPBOARD_UNAVAILABLE'), { cause: lastError })
}
