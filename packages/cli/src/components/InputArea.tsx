import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { theme } from '../theme.js';

interface Props {
  onSubmit: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function InputArea({ onSubmit, disabled, placeholder }: Props) {
  const [value, setValue] = useState('');
  const [accumulatedLines, setAccumulatedLines] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useInput((input, key) => {
    if (disabled) return;

    if (key.upArrow) {
      if (historyIndex < history.length - 1) {
        const nextIndex = historyIndex + 1;
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] || '');
      }
    } else if (key.downArrow) {
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setValue(history[history.length - 1 - nextIndex] || '');
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setValue('');
      }
    }
  });

  const handleSubmit = (text: string) => {
    if (text.endsWith('\\')) {
      const newLine = text.slice(0, -1);
      setAccumulatedLines([...accumulatedLines, newLine]);
      setValue('');
    } else {
      const finalLines = [...accumulatedLines, text];
      const fullText = finalLines.join('\n');
      if (fullText.trim()) {
        const newHistory = [...history, fullText].slice(-50);
        setHistory(newHistory);
      }
      setHistoryIndex(-1);
      setAccumulatedLines([]);
      setValue('');
      onSubmit(fullText);
    }
  };

  const promptChar = accumulatedLines.length > 0 ? '…' : '›';
  const promptColor = disabled ? theme.dim : theme.primary;

  return (
    <Box flexDirection="column">
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
            value={value}
            onChange={setValue}
            onSubmit={handleSubmit}
            placeholder={placeholder || ''}
          />
        )}
      </Box>
    </Box>
  );
}
