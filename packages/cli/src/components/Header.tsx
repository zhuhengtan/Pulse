import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import path from 'node:path';

interface Props {
  title: string;
  cwd: string;
  model: string;
  approvalMode?: 'read-only' | 'ask' | 'auto' | undefined;
}

export function Header({ title, cwd, model }: Props) {
  const cwdBasename = path.basename(cwd);

  return (
    <Box borderBottom borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} width="100%" flexShrink={0} justifyContent="space-between">
      <Box gap={1} flexShrink={1} overflow="hidden">
        <Text color={theme.primary} bold> PULSE </Text>
        <Text color="white" wrap="truncate-end">{title.length > 36 ? `${title.slice(0, 36)}…` : title}</Text>
      </Box>
      <Box gap={1} flexShrink={1} overflow="hidden">
        <Text color={theme.dim} wrap="truncate-end">{cwdBasename}</Text>
        <Text color={theme.dim}>·</Text>
        <Text color={theme.dim} wrap="truncate-end">{model}</Text>
      </Box>
    </Box>
  );
}
