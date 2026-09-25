import { Box, Text, useInput } from 'ink';
import TextInput from './TextInput.js';
import { useState } from 'react';
import { searchSlashSuggestions, type SlashSuggestion } from '../utils/slashCompletion.js';
import { theme } from '../theme.js';

interface Props {
  suggestions?: SlashSuggestion[];
  onSearchSkills?: () => void;
  onSubmit: (text: string) => void;
  onRememberInput: (text: string) => void;
  onNavigateHistory: (direction: 'up' | 'down', currentValue: string) => string | undefined;
  disabled?: boolean;
  focus?: boolean;
  placeholder?: string;
}

export function InputArea({ onSubmit, onRememberInput, onNavigateHistory, disabled, focus = true, placeholder, suggestions = [], onSearchSkills }: Props) {
  const [value, setValue] = useState('');
  const [completionRevision, setCompletionRevision] = useState(0);
  const [selected, setSelected] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const matches = dismissed ? [] : searchSlashSuggestions(value, suggestions);
  const chosen = Math.min(selected, Math.max(0, matches.length - 1));
  const changeValue = (next: string) => {
    if (next.startsWith('/') && !value.startsWith('/')) onSearchSkills?.();
    setSelected(0); setDismissed(false); setValue(next);
  };
  const [accumulatedLines, setAccumulatedLines] = useState<string[]>([]);
  useInput((input, key) => {
    if (disabled || !focus) return;
    if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;

    if (matches.length && !accumulatedLines.length) {
      if (key.escape) { setDismissed(true); return; }
      if (key.upArrow || key.downArrow) { setSelected(Math.max(0, Math.min(matches.length - 1, chosen + (key.upArrow ? -1 : 1)))); return; }
      if (key.tab) { setValue(`${matches[chosen]!.name} `); setCompletionRevision(revision => revision + 1); setSelected(0); return; }
    }
    if (key.return) {
      if (key.shift) {
        setAccumulatedLines((current) => [...current, value]);
        setValue('');
      } else {
        handleSubmit(value);
      }
      return;
    }

    if (key.upArrow) {
      const previous = onNavigateHistory('up', [...accumulatedLines, value].join('\n'));
      if (previous !== undefined) restoreInput(previous);
    } else if (key.downArrow) {
      const next = onNavigateHistory('down', [...accumulatedLines, value].join('\n'));
      if (next !== undefined) restoreInput(next);
    }
  });

  const restoreInput = (text: string) => {
    const lines = text.split('\n');
    setAccumulatedLines(lines.slice(0, -1));
    changeValue(lines.at(-1) ?? '');
  };

  const handleSubmit = (text: string) => {
    if (text.endsWith('\\')) {
      const newLine = text.slice(0, -1);
      setAccumulatedLines([...accumulatedLines, newLine]);
      setValue('');
    } else {
      const finalLines = [...accumulatedLines, text];
      const fullText = finalLines.join('\n');
      if (fullText.trim()) {
        onRememberInput(fullText);
      }
      setAccumulatedLines([]);
      setValue('');
      onSubmit(fullText);
    }
  };

  const promptChar = accumulatedLines.length > 0 ? '…' : '›';
  const promptColor = disabled ? theme.dim : theme.primary;

  return (
    <Box flexDirection="column">
      {matches.length > 0 && accumulatedLines.length === 0 && (
        <Box flexDirection="column">
          {matches.slice(Math.max(0, chosen - 5), Math.max(0, chosen - 5) + 6).map(item => (
            <Text key={item.name} color={item === matches[chosen] ? theme.primary : theme.dim}>
              {item === matches[chosen] ? '› ' : '  '}{item.name}  {item.description}
            </Text>
          ))}
          <Text dimColor>↑↓ 选择 · Tab 补全 · 输入任务后 Enter 发送 · Esc 收起（{matches.length} 项）</Text>
        </Box>
      )}
      {accumulatedLines.map((line, idx) => (
        <Box key={idx}>
          <Text color={promptColor}>{promptChar} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
      <Box>
        <Text color={promptColor}>{promptChar} </Text>
        {disabled ? (
          <Text color={theme.dim}>{placeholder || '处理中...'}</Text>
        ) : (
          <TextInput
            key={completionRevision}
            focus={focus}
            value={value}
            onChange={changeValue}
            placeholder={placeholder || ''}
          />
        )}
      </Box>
    </Box>
  );
}
