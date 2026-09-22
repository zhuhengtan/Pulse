import process from 'node:process';

const completeOsc = /\u001B\][\s\S]*?(?:\u0007|\u001B\\)/g
const incompleteOsc = /\u001B\][\s\S]*$/g
const csi = /[\u001B\u009B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const otherEscape = /\u001B[@-_]/g
const unsafeControls = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g

export function stripAnsi(text: string): string {
  return text.replace(csi, '')
}

/** Remove terminal control sequences from untrusted text before display. */
export function stripTerminalControls(text: string): string {
  return text.replace(completeOsc, '').replace(incompleteOsc, '').replace(csi, '').replace(otherEscape, '').replace(unsafeControls, '')
}

export function terminalWidth(): number {
  return process.stdout.columns || 80;
}

export function horizontalLine(width?: number): string {
  const w = width || terminalWidth();
  return '─'.repeat(Math.max(1, w));
}
