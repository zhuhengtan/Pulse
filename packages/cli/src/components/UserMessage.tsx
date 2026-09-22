import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { stripTerminalControls } from '../utils/ansi.js';

export interface UserMessageProps {
  text: string;
  timestamp?: string;
}

export function UserMessage({ text, timestamp }: UserMessageProps) {
  return (
    <Box marginY={1} gap={1}>
      <Text color={theme.user}>›</Text>
      <Box flexDirection="column">
        <Text>{stripTerminalControls(text)}</Text>
      </Box>
      {timestamp && (
        <Box marginLeft={1}>
          <Text color={theme.dim} dimColor>{timestamp}</Text>
        </Box>
      )}
    </Box>
  );
}
