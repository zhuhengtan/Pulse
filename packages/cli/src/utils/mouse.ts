/** SGR mouse reporting. Ink removes the first ESC before delivering unknown keys. */
export function mouseEvent(input: string): { wheel: number } | undefined {
  const match = /^(?:\x1b)?\[<(\d+);\d+;\d+([Mm])$/.exec(input);
  if (!match) return undefined;
  const button = Number(match[1]);
  const base = button & ~28; // Shift, Alt and Ctrl modifiers do not change direction.
  return { wheel: match[2] === 'M' && base === 64 ? -3 : match[2] === 'M' && base === 65 ? 3 : 0 };
}
export const enableMouse = '\x1b[?1000h\x1b[?1006h';
export const disableMouse = '\x1b[?1006l\x1b[?1000l';
