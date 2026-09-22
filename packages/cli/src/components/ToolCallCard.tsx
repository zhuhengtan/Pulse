import { Box, Text, useFocus, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import type { ToolCallDisplay } from '../types.js';

interface Props {
  call: ToolCallDisplay;
  expanded?: boolean;
  onToggle?: () => void;
}

function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code : undefined;
    const message = typeof record.message === 'string' ? record.message : undefined;
    if (code && message) return `${code}: ${message}`;
    if (message) return message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
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
      case 'cancelled': return <Text color={theme.warning}>⊘</Text>;
      default: return <Text>?</Text>;
    }
  };

  const argsJson = call.arguments ? JSON.stringify(call.arguments, null, 2) : '{}';
  const resultJson = call.result === undefined ? '' : JSON.stringify(call.result);
  const resultSummary = resultJson.length > 500 ? resultJson.slice(0, 500) + '...' : resultJson;
  const failureSummary = call.status === 'failed'
    ? resultText(call.result ?? '工具执行失败')
    : call.status === 'cancelled'
      ? resultText(call.result ?? '工具执行已取消')
      : '';

  return (
    <Box borderStyle="round" borderColor={isFocused ? theme.tool : theme.border} flexDirection="column" paddingX={1}>
      <Box gap={1}>
        <Text>🔧</Text>
        <Text color={theme.tool} bold>{call.name}</Text>
        {getStatusIcon()}
        {failureSummary && <Text color={call.status === 'failed' ? theme.error : theme.warning}> {failureSummary}</Text>}
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
              <Text color={theme.dim}>{call.status === 'failed' ? '错误:' : call.status === 'cancelled' ? '取消原因:' : '结果:'}</Text>
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
