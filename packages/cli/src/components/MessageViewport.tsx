import { Box, Text, useInput, useStdout } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { theme } from '../theme.js';
import type { DisplayMessage, Verbosity } from '../types.js';
import { AssistantMessage } from './AssistantMessage.js';
import { UserMessage } from './UserMessage.js';
import { stripTerminalControls } from '../utils/ansi.js';

interface Props {
  messages: DisplayMessage[];
  showThinking?: boolean;
  verbosity?: Verbosity;
  isRunning?: boolean;
}

const minimumViewportRows = 5;

function messageWeight(message: DisplayMessage, width: number): number {
  const contentWidth = Math.max(24, width - 8);
  const text = stripTerminalControls(message.text || message.thinking || '');
  const textRows = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / contentWidth)), 0);
  const toolRows = message.toolCalls?.length ? message.toolCalls.length + 1 : 0;
  return Math.max(2, textRows + toolRows + (message.role === 'system' ? 1 : 2));
}

function renderMessage(message: DisplayMessage, showThinking: boolean, verbosity: Verbosity, isLast: boolean) {
  return (
    <Box key={message.id} flexDirection="column">
      {message.role === 'user' && <UserMessage text={message.text} timestamp={message.createdAt} />}
      {message.role === 'assistant' && (
        <AssistantMessage
          text={message.text}
          thinking={message.thinking}
          showThinking={showThinking}
          verbosity={verbosity}
          toolCalls={message.toolCalls}
          tokenStats={message.tokenStats}
        />
      )}
      {message.role === 'system' && (
        <Box paddingX={1} marginY={1}>
          <Text color={theme.dim} italic>{stripTerminalControls(message.text)}</Text>
        </Box>
      )}
      {!isLast && <Box height={1} />}
    </Box>
  );
}

/**
 * A bounded message window. Ink has no built-in scroll viewport, so only the
 * visible message window is reconciled. This keeps streaming output from
 * re-rendering the whole transcript and leaves the header/HUD/input stable.
 */
export function MessageViewport({ messages, showThinking = false, verbosity = 'normal', isRunning = false }: Props) {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows || 24);
  const [scrollOffset, setScrollOffset] = useState(0);

  useEffect(() => {
    const onResize = () => setRows(stdout.rows || 24);
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  const viewportRows = Math.max(minimumViewportRows, rows - (isRunning ? 9 : 7));
  const width = stdout.columns || 100;
  const weights = useMemo(() => messages.map((message) => messageWeight(message, width)), [messages, width]);
  const totalRows = weights.reduce((sum, weight) => sum + weight, 0);
  const maxScroll = Math.max(0, totalRows - viewportRows);

  useEffect(() => {
    if (isRunning) setScrollOffset(0);
    else setScrollOffset((current) => Math.min(current, maxScroll));
  }, [isRunning, maxScroll, messages.length]);

  useInput((_input, key) => {
    if (key.pageUp) {
      setScrollOffset((current) => Math.min(maxScroll, current + Math.max(1, viewportRows - 2)));
    } else if (key.pageDown) {
      setScrollOffset((current) => Math.max(0, current - Math.max(1, viewportRows - 2)));
    } else if (key.home) {
      setScrollOffset(maxScroll);
    } else if (key.end) {
      setScrollOffset(0);
    }
  });

  // scrollOffset is measured from the newest message: 0 means follow the
  // bottom, maxScroll means show the oldest visible window.
  let remaining = Math.max(0, totalRows - viewportRows - scrollOffset);
  let startIndex = 0;
  while (startIndex < weights.length && remaining >= weights[startIndex]!) {
    remaining -= weights[startIndex]!;
    startIndex++;
  }

  let visibleRows = 0;
  let endIndex = startIndex;
  while (endIndex < messages.length && visibleRows < viewportRows + 1) {
    visibleRows += weights[endIndex]!;
    endIndex++;
  }
  const visibleMessages = messages.slice(startIndex, endIndex);
  const isAtBottom = scrollOffset === 0;

  return (
    <Box flexDirection="column" height={viewportRows} overflow="hidden">
      {!isAtBottom && <Text color={theme.dim}>↑ PageUp 查看更早消息 · PageDown 返回最新</Text>}
      {visibleMessages.length === 0 ? (
        <Box flexGrow={1} />
      ) : (
        visibleMessages.map((message, index) => renderMessage(message, showThinking, verbosity, startIndex + index === messages.length - 1))
      )}
      {maxScroll > 0 && isAtBottom && <Text color={theme.dim}>↓ 已在最新消息 · PageUp 滚动历史</Text>}
    </Box>
  );
}
