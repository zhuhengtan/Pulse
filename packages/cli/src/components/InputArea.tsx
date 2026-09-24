import { Box, Text, useInput } from 'ink';
import TextInput from './TextInput.js';
import { useState } from 'react';
import { theme } from '../theme.js';

interface Props {
  onSubmit: (text: string) => void;
  onRememberInput: (text: string) => void;
  onNavigateHistory: (direction: 'up' | 'down', currentValue: string) => string | undefined;
  disabled?: boolean;
  focus?: boolean;
  placeholder?: string;
}

export function InputArea({ onSubmit, onRememberInput, onNavigateHistory, disabled, focus = true, placeholder }: Props) {
  const [value, setValue] = useState('');
  const [accumulatedLines, setAccumulatedLines] = useState<string[]>([]);
  useInput((input, key) => {
    if (disabled || !focus) return;
    if (key.ctrl || key.meta || key.pageUp || key.pageDown) return;

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
    setValue(lines.at(-1) ?? '');
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
            focus={focus}
            value={value}
            onChange={setValue}
            placeholder={placeholder || ''}
          />
        )}
      </Box>
    </Box>
  );
}
