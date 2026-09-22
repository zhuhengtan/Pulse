import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface WelcomeProps {
  cwd: string;
  model: string;
  version: string;
}

export function Welcome({ cwd, model, version }: WelcomeProps) {
  return (
    <Box borderStyle="round" borderColor={theme.border} paddingX={2} paddingY={1} flexDirection="column">
      <Box gap={1}>
        <Text color={theme.primary} bold>Pulse</Text>
        <Text color={theme.dim}>v{version}</Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        <Text>
          <Text color={theme.dim}>Workspace: </Text>
          <Text>{cwd}</Text>
        </Text>
        <Text>
          <Text color={theme.dim}>Model: </Text>
          <Text>{model}</Text>
        </Text>
      </Box>
      <Text color={theme.dim}>Type /help for commands.</Text>
    </Box>
  );
}
