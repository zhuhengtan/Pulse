import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { theme } from '../theme.js';
import path from 'node:path';

interface Session {
  id: string;
  title: string;
  updatedAt: string;
  cwd: string;
}

interface Props {
  sessions: Session[];
  notice?: string | null;
  onSelect: (id: string) => void;
  onDelete?: (id: string) => void | Promise<void>;
  onBack: () => void;
}

const PAGE_SIZE = 10;

export function SessionList({ sessions, notice, onSelect, onDelete, onBack }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const clampedIndex = sessions.length === 0 ? 0 : Math.min(Math.max(0, selectedIndex), sessions.length - 1);
  const highlightedSession = sessions[clampedIndex];

  useInput((input, key) => {
    if (pendingDelete) {
      if (input === 'd' && onDelete) {
        void Promise.resolve(onDelete(pendingDelete));
        setPendingDelete(null);
      } else if (input === 'n' || input === 'q' || input === 'd' || key.escape) {
        setPendingDelete(null);
      }
      return;
    }

    if (input === 'q' || key.escape) {
      onBack();
      return;
    }

    if (input === 'd' && highlightedSession && onDelete) {
      setPendingDelete(highlightedSession.id);
      return;
    }

    if (key.upArrow || input === 'k') {
      // Strictly clamp to top - NEVER wrap around on trackpad bounce
      setSelectedIndex((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.downArrow || input === 'j') {
      // Strictly clamp to bottom - NEVER wrap around on trackpad bounce
      setSelectedIndex((prev) => Math.min(Math.max(0, sessions.length - 1), prev + 1));
      return;
    }

    if (key.return) {
      if (highlightedSession) {
        onSelect(highlightedSession.id);
      }
      return;
    }
  });

  const total = sessions.length;
  // Windowing logic so the list never overflows terminal height
  const halfPage = Math.floor(PAGE_SIZE / 2);
  let startIndex = Math.max(0, clampedIndex - halfPage);
  let endIndex = Math.min(total, startIndex + PAGE_SIZE);
  if (endIndex - startIndex < PAGE_SIZE) {
    startIndex = Math.max(0, endIndex - PAGE_SIZE);
  }
  const visibleSessions = sessions.slice(startIndex, endIndex);

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={theme.primary} bold>会话列表 (↑↓ 选择, Enter 继续, d 删除, q 返回)</Text>
      </Box>
      {notice && (
        <Box marginBottom={1}>
          <Text color={theme.error}>{notice}</Text>
        </Box>
      )}
      {pendingDelete && (
        <Box marginBottom={1}>
          <Text color={theme.warning}>再按 d 确认删除，按 n 取消。</Text>
        </Box>
      )}
      {total === 0 ? (
        <Text color={theme.dim}>暂无历史会话。按 q 返回。</Text>
      ) : (
        <Box flexDirection="column">
          {startIndex > 0 && (
            <Box paddingLeft={2} marginBottom={1}>
              <Text color={theme.dim}>▲ 上方还有 {startIndex} 个会话...</Text>
            </Box>
          )}
          {visibleSessions.map((s, idx) => {
            const actualIndex = startIndex + idx;
            const isSelected = actualIndex === clampedIndex;
            const label = `${s.title.length > 30 ? s.title.slice(0, 30) + '...' : s.title} (${s.updatedAt}) - ${path.basename(s.cwd)}`;
            return (
              <Box key={s.id}>
                <Text {...(isSelected ? { color: theme.primary } : {})}>
                  {isSelected ? '❯ ' : '  '}
                </Text>
                <Text {...(isSelected ? { color: theme.primary, bold: true } : {})}>
                  {label}
                </Text>
              </Box>
            );
          })}
          {endIndex < total && (
            <Box paddingLeft={2} marginTop={1}>
              <Text color={theme.dim}>▼ 下方还有 {total - endIndex} 个会话...</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
