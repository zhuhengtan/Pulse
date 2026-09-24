import { Box, Text, useInput, useStdout, measureElement, type DOMElement } from 'ink';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { mouseEvent, enableMouse, disableMouse } from '../utils/mouse.js';
import { theme } from '../theme.js';
import type { DisplayMessage, Verbosity } from '../types.js';
import { transcriptLines, scrollAction } from '../utils/transcript.js';

interface Props { mouseEnabled?: boolean; messages: DisplayMessage[]; showThinking?: boolean; verbosity?: Verbosity; isRunning?: boolean }

export function MessageViewport({ messages, verbosity = 'normal', mouseEnabled = true }: Props) {
  const { stdout } = useStdout();
  useEffect(() => {
    if (!mouseEnabled || !stdout.isTTY) return;
    stdout.write(enableMouse);
    return () => { stdout.write(disableMouse); };
  }, [mouseEnabled, stdout]);
  const box = useRef<DOMElement>(null);
  const [size, setSize] = useState({ width: stdout.columns || 80, height: 12 });
  const [start, setStart] = useState<number | null>(null);
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
  useInput((input, key) => {
    const mouse = mouseEvent(input);
    if (mouse) {
      if (mouseEnabled && mouse.wheel) setStart((previous) => {
        const next = Math.max(0, Math.min(bottom, (previous === null ? bottom : Math.min(previous, bottom)) + mouse.wheel));
        return next === bottom ? null : next;
      });
      return;
    }
    const action = scrollAction(input, key);
    if (action === 'up') setStart(Math.max(0, first - Math.max(1, page - 2)));
    if (action === 'down') { const next = Math.min(bottom, first + Math.max(1, page - 2)); setStart(next === bottom ? null : next); }
    if (action === 'bottom') setStart(null);
  });
  return (
    <Box ref={box} flexDirection="column" flexGrow={1} flexShrink={1} flexBasis={0} minHeight={3} overflow="hidden">
      <Box flexDirection="column" height={page} overflow="hidden"><Text>{lines.slice(first, first + page).join('\n')}</Text></Box>
      <Text color={theme.dim}>{start === null ? (mouseEnabled ? '滚轮 / 双指滚动 · Ctrl+G 回到底部' : 'Ctrl+P 上翻 · Ctrl+N 下翻') : `历史 ${first + 1}–${Math.min(lines.length, first + page)}/${lines.length} · 滚动浏览 · Ctrl+G 回到底部`}</Text>
    </Box>
  );
}
