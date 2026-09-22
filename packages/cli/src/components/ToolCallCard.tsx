import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import type { ToolCallDisplay } from '../types.js';

interface Props {
  call: ToolCallDisplay;
  expanded?: boolean;
  onToggle?: () => void;
}

export function ToolCallCard({ call, expanded: defaultExpanded = false, onToggle }: Props) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const { isFocused } = useFocus({ autoFocus: false });

  const isExpanded = onToggle ? defaultExpanded : internalExpanded;

  useInput((input, key) => {
    if (isFocused && (key.return || input === ' ')) {
      if (onToggle) {
        onToggle();
      } else {
        setInternalExpanded(!isExpanded);
      }
    }
  });

  const getStatusIcon = () => {
    switch (call.status) {
      case 'running': return <Text color={theme.warning}>⏳</Text>;
      case 'succeeded': return <Text color={theme.success}>✓</Text>;
      case 'failed': return <Text color={theme.error}>✗</Text>;
      default: return <Text>?</Text>;
    }
  };

  const argsJson = call.arguments ? JSON.stringify(call.arguments, null, 2) : '{}';
  const resultJson = call.result ? JSON.stringify(call.result) : '';
  const resultSummary = resultJson.length > 500 ? resultJson.slice(0, 500) + '...' : resultJson;

  return (
    <Box borderStyle="round" borderColor={isFocused ? theme.tool : theme.border} flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text>🔧</Text>
        <Text color={theme.tool} bold>{call.name}</Text>
        {getStatusIcon()}
        {call.durationMs && <Text color={theme.dim}>{call.durationMs}ms</Text>}
      </Box>
      {isExpanded && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.dim}>参数:</Text>
          <Box paddingLeft={2}>
            <Text color={theme.codeLang}>{argsJson}</Text>
          </Box>
          {call.result !== undefined && call.result !== null ? (
            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.dim}>结果:</Text>
              <Box paddingLeft={2}>
                <Text color={theme.codeLang}>{resultSummary}</Text>
              </Box>
            </Box>
          ) : null}
        </Box>
      )}
    </Box>
  );
}
