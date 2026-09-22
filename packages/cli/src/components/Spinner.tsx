import { Box, Text } from 'ink';
import InkSpinner from 'ink-spinner';
import { theme } from '../theme.js';

export interface SpinnerProps {
  label?: string;
}

export function Spinner({ label }: SpinnerProps) {
  return (
    <Box gap={1}>
      <Text color={theme.primary}>
        <InkSpinner type="dots" />
      </Text>
      {label && <Text color={theme.dim}>{label}</Text>}
    </Box>
  );
}
