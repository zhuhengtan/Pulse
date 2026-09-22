import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
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

export function SessionList({ sessions, notice, onSelect, onDelete, onBack }: Props) {
  const [highlightedId, setHighlightedId] = useState<string | null>(sessions[0]?.id ?? null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useInput((input) => {
    if (pendingDelete) {
      if (input === 'd' && highlightedId === pendingDelete && onDelete) {
        void Promise.resolve(onDelete(pendingDelete));
        setPendingDelete(null);
      } else if (input === 'n' || input === 'q' || input === 'd') {
        setPendingDelete(null);
      }
      return;
    }
    if (input === 'q') {
      onBack();
    } else if (input === 'd' && highlightedId && onDelete) {
      setPendingDelete(highlightedId);
    }
  });

  const items = sessions.map(s => ({
    label: `${s.title.length > 30 ? s.title.slice(0, 30) + '...' : s.title} (${s.updatedAt}) - ${path.basename(s.cwd)}`,
    value: s.id
  }));

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
      {items.length === 0 ? (
        <Text color={theme.dim}>暂无历史会话。按 q 返回。</Text>
      ) : (
        <SelectInput
          items={items}
          onSelect={(item: { label: string; value: string }) => onSelect(item.value)}
          onHighlight={(item: { label: string; value: string }) => setHighlightedId(item.value)}
        />
      )}
    </Box>
  );
}
