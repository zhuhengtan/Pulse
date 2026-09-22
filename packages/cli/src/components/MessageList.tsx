import { Box, Static, Text } from 'ink';
import { theme } from '../theme.js';
import type { DisplayMessage, Verbosity } from '../types.js';
import { UserMessage } from './UserMessage.js';
import { AssistantMessage } from './AssistantMessage.js';
import { stripTerminalControls } from '../utils/ansi.js';

interface Props {
  messages: DisplayMessage[];
  showThinking?: boolean | undefined;
  verbosity?: Verbosity | undefined;
  isRunning?: boolean | undefined;
}

export function MessageList({ messages, showThinking, verbosity = 'normal', isRunning = false }: Props) {
  const staticMessages = isRunning ? messages.slice(0, -1) : messages;
  const liveMessage = isRunning ? messages.at(-1) : undefined;

  const renderMessage = (msg: DisplayMessage, index: number, isLast: boolean) => (
    <Box key={msg.id || index} flexDirection="column">
      {msg.role === 'user' && (
        <UserMessage text={msg.text} timestamp={msg.createdAt} />
      )}

      {msg.role === 'assistant' && (
        <AssistantMessage
          text={msg.text}
          thinking={msg.thinking}
          showThinking={showThinking}
          verbosity={verbosity}
          toolCalls={msg.toolCalls}
          tokenStats={msg.tokenStats}
        />
      )}

      {msg.role === 'system' && (
        <Box paddingX={1}>
          <Text color={theme.dim} italic>{stripTerminalControls(msg.text)}</Text>
        </Box>
      )}

      {!isLast && <Box height={1} />}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {/* Completed messages are printed once so streaming updates do not redraw terminal history. */}
      <Static items={staticMessages}>
        {(msg, index) => renderMessage(msg, index, false)}
      </Static>
      {liveMessage && renderMessage(liveMessage, messages.length - 1, true)}
    </Box>
  );
}
