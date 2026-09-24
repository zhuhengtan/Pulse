import { Box, Text, useInput, useStdout, measureElement, type DOMElement } from 'ink';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mouseEvent, enableMouse, disableMouse } from '../utils/mouse.js';
import { theme } from '../theme.js';
import type { DisplayMessage, Verbosity } from '../types.js';
import { transcriptLines, scrollAction } from '../utils/transcript.js';
import { selectedLine, selectedText, type TextPoint, type TextSelection } from '../utils/selection.js';
import { copyToClipboard } from '../utils/clipboard.js';

interface Props { mouseEnabled?: boolean; messages: DisplayMessage[]; showThinking?: boolean; verbosity?: Verbosity; isRunning?: boolean; onSelectionChange?: (text: string) => void }

export function MessageViewport({ messages, verbosity = 'normal', mouseEnabled = true, onSelectionChange }: Props) {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!mouseEnabled || !stdout.isTTY) return;
    stdout.write(enableMouse);
    return () => { stdout.write(disableMouse); };
  }, [mouseEnabled, stdout]);
  const box = useRef<DOMElement>(null);
  const [size, setSize] = useState({ width: stdout.columns || 80, height: 12 });
  const [start, setStart] = useState<number | null>(null);
  const [selection, setSelection] = useState<TextSelection>();
  const selectionRef = useRef<TextSelection | undefined>(undefined);
  const selecting = useRef(false);
  const selectionAnchor = useRef<TextPoint | undefined>(undefined);
  useLayoutEffect(() => {
    if (!box.current) return;
    const measured = measureElement(box.current);
    setSize((previous) => previous.width === measured.width && previous.height === measured.height ? previous : measured);
  });
  useEffect(() => { const resize = () => setSize((s) => ({ ...s, width: stdout.columns || 80 })); stdout.on('resize', resize); return () => { stdout.off('resize', resize); }; }, [stdout]);
  const lines = useMemo(() => transcriptLines(messages, size.width, verbosity), [messages, size.width, verbosity]);
  const page = Math.max(1, size.height - 1);
  const bottom = Math.max(0, lines.length - page);
  const first = start === null ? bottom : Math.min(start, bottom);
  const pointAt = (x: number, y: number): TextPoint | undefined => {
    if (!box.current) return undefined;
    const layout = measureElement(box.current);
    const localY = y - layout.y;
    if (localY < 0 || localY >= page) return undefined;
    return { line: Math.max(0, Math.min(lines.length - 1, first + localY)), column: Math.max(0, x - layout.x) };
  };
  const publishSelection = (next?: TextSelection) => {
    selectionRef.current = next;
    setSelection(next);
    onSelectionChange?.(next ? selectedText(lines, next) : '');
  };
  useInput((input, key) => {
    const mouse = mouseEvent(input);
    if (mouse) {
      if (mouseEnabled && mouse.phase === 'wheel') setStart((previous) => {
        const next = Math.max(0, Math.min(bottom, (previous === null ? bottom : Math.min(previous, bottom)) + mouse.wheel));
        return next === bottom ? null : next;
      });
      const isLeftButton = (mouse.button & 3) === 0;
      if (mouseEnabled && isLeftButton && mouse.phase === 'press') {
        const point = pointAt(mouse.x, mouse.y);
        if (point) {
          selecting.current = true;
          selectionAnchor.current = point;
          publishSelection({ start: point, end: point });
        }
      } else if (mouseEnabled && selecting.current && mouse.phase === 'drag') {
        const layout = box.current ? measureElement(box.current) : undefined;
        if (layout && mouse.y < layout.y) setStart((previous) => Math.max(0, (previous === null ? bottom : previous) - 1));
        if (layout && mouse.y >= layout.y + page) setStart((previous) => Math.min(bottom, (previous === null ? bottom : previous) + 1));
        const localY = layout ? Math.max(0, Math.min(page - 1, mouse.y - layout.y)) : mouse.y;
        const point = pointAt(mouse.x, (layout?.y ?? 0) + localY);
        if (point && selectionAnchor.current) publishSelection({ start: selectionAnchor.current, end: point });
      } else if (selecting.current && mouse.phase === 'release') {
        selecting.current = false;
        const completed = selectionRef.current;
        if (selectionAnchor.current && completed && completed.start.line === completed.end.line && completed.start.column === completed.end.column) {
          selectionAnchor.current = undefined;
          publishSelection(undefined);
        } else if (completed) {
          // Terminal emulators reserve Command+C before the CLI can see it.
          // Sync the custom selection on mouse release so the standard copy
          // shortcut always finds the selected text in the system clipboard.
          void copyToClipboard(selectedText(lines, completed)).catch(() => {});
        }
      }
      return;
    }
    if (key.escape && selection) { selecting.current = false; selectionAnchor.current = undefined; publishSelection(undefined); return; }
    const action = scrollAction(input, key);
    if (action === 'up') setStart(Math.max(0, first - Math.max(1, page - 2)));
    if (action === 'down') { const next = Math.min(bottom, first + Math.max(1, page - 2)); setStart(next === bottom ? null : next); }
    if (action === 'bottom') setStart(null);
  });
  return (
    <Box ref={box} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={3} overflow="hidden">
      <Box flexDirection="column" height={page} overflow="hidden"><Text>{lines.slice(first, first + page).map((line, index) => selectedLine(line, first + index, selection)).join('\n')}</Text></Box>
      <Text color={theme.dim}>{selection ? '已选中 · 松开鼠标已复制 · Ctrl+C / /copy 复制 · Esc 取消选择' : start === null ? (mouseEnabled ? '滚轮 / 双指滚动 · 拖动选择后自动复制 · Ctrl+C 复制选区 · /copy 复制回复 · Ctrl+G 回到底部' : 'Ctrl+P 上翻 · Ctrl+N 下翻 · 终端可原生选择文字') : `历史 ${first + 1}–${Math.min(lines.length, first + page)}/${lines.length} · 滚动浏览 · 拖动选择后自动复制 · Ctrl+C / /copy 复制 · Ctrl+G 回到底部`}</Text>
    </Box>
  );
}
