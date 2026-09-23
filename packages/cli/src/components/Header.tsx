import { Box, Text } from 'ink';
import { theme } from '../theme.js';
import path from 'node:path';

interface Props {
  title: string;
  cwd: string;
  model: string;
  approvalMode?: 'read-only' | 'ask' | 'auto' | undefined;
}

export function Header({ title, cwd, model, approvalMode = 'ask' }: Props) {
  const cwdBasename = path.basename(cwd);
  const approvalLabel = approvalMode === 'auto' ? 'AUTO' : approvalMode === 'read-only' ? 'READ-ONLY' : 'ASK';

  return (
    <Box borderBottom borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} width="100%" justifyContent="space-between">
      <Box gap={1}>
        <Text color={theme.primary} bold> PULSE </Text>
        <Text color="white" bold>{title}</Text>
      </Box>
      <Box gap={1}>
        <Text color={theme.dim}>{cwdBasename}</Text>
        <Text color={theme.dim}>·</Text>
        <Text color={theme.dim}>{model}</Text>
        <Text color={approvalMode === 'auto' ? theme.warning : theme.dim}>{approvalLabel}</Text>
      </Box>
    </Box>
  );
}
