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

  return (
    <Box borderBottom borderStyle="single" borderColor={theme.border} borderTop={false} borderLeft={false} borderRight={false} width="100%">
      <Text color={theme.primary} bold>Pulse</Text>
      <Text color={theme.dim}> · </Text>
      <Text color="white">{title}</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.dim}>{model}</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={approvalMode === 'auto' ? theme.warning : theme.dim}>
        {approvalMode === 'auto' ? '自动批准' : approvalMode === 'read-only' ? '只读' : '需审批'}
      </Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.dim}>{cwdBasename}</Text>
    </Box>
  );
}
