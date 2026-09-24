export interface TerminalMouseEvent {
  x: number
  y: number
  button: number
  phase: 'press' | 'drag' | 'release' | 'wheel'
  wheel: number
}

/** SGR mouse reporting. Ink removes the first ESC before delivering unknown keys. */
export function mouseEvent(input: string): TerminalMouseEvent | undefined {
  const match = /^(?:\x1b)?\[<(\d+);(\d+);(\d+)([Mm])$/.exec(input)
  if (!match) return undefined
  const button = Number(match[1])
  const x = Number(match[2]) - 1
  const y = Number(match[3]) - 1
  const final = match[4]
  const base = button & ~28 // Shift, Alt and Ctrl modifiers do not change direction.
  if (base === 64 || base === 65) return { x, y, button, phase: 'wheel', wheel: base === 64 ? -3 : 3 }
  if (final === 'm' || (button & 3) === 3) return { x, y, button, phase: 'release', wheel: 0 }
  if ((button & 32) !== 0) return { x, y, button, phase: 'drag', wheel: 0 }
  return { x, y, button, phase: 'press', wheel: 0 }
}

// Button-event tracking reports press/release/drag while retaining wheel events.
export const enableMouse = '\x1b[?1002h\x1b[?1006h'
export const disableMouse = '\x1b[?1006l\x1b[?1002l'
