import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import { stripTerminalControls } from '../utils/ansi.js';

export interface UserMessageProps {
  text: string;
  timestamp?: string;
}

export function UserMessage({ text, timestamp }: UserMessageProps) {
  return (
    <Box marginY={1} paddingLeft={1} borderStyle="single" borderLeft borderTop={false} borderRight={false} borderBottom={false} borderColor={theme.user} flexDirection="column">
      <Box gap={1}>
        <Text color={theme.user} bold>YOU</Text>
        {timestamp && <Text color={theme.dim} dimColor>{timestamp}</Text>}
      </Box>
      <Text color="white">{stripTerminalControls(text)}</Text>
    </Box>
  );
}
