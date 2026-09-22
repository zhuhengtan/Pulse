import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import type { DisplayMessage, Verbosity } from '../types.js';
import { UserMessage } from './UserMessage.js';
import { AssistantMessage } from './AssistantMessage.js';
import { stripTerminalControls } from '../utils/ansi.js';

interface Props {
  messages: DisplayMessage[];
  showThinking?: boolean | undefined;
  verbosity?: Verbosity | undefined;
}

export function MessageList({ messages, showThinking, verbosity = 'normal' }: Props) {
  return (
    <Box flexDirection="column">
      {messages.map((msg, index) => {
        const isLast = index === messages.length - 1;

        return (
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
      })}
    </Box>
  );
}
