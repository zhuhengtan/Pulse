import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface ThinkingBlockProps {
  content: string;
  visible?: boolean;
}

export function ThinkingBlock({ content, visible }: ThinkingBlockProps) {
  if (!visible) return null;

  return (
    <Box
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderColor={theme.thinking}
      paddingLeft={1}
      marginY={1}
    >
      <Text color={theme.thinking} dimColor>{content}</Text>
    </Box>
  );
}
