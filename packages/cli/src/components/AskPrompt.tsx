import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { useState } from 'react';
import { theme } from '../theme.js';
import type { AskRequest } from '../types.js';

interface Props {
  request: AskRequest;
  disabled?: boolean;
  onReply: (value: Record<string, unknown>) => void;
}

export function AskPrompt({ request, disabled = false, onReply }: Props) {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const options = request.options ?? [];
  const clampedIndex = options.length === 0 ? 0 : Math.min(Math.max(0, index), options.length - 1);

  useInput((input, key) => {
    if (disabled || (request.type !== 'choice' && request.type !== 'multi') || options.length === 0) return;
    if (key.upArrow) {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((current) => Math.min(options.length - 1, current + 1));
      return;
    }
    if (request.type === 'choice' && key.return) {
      const option = options[Math.min(Math.max(0, index), options.length - 1)];
      if (option) onReply({ value: option.value });
      return;
    }
    if (request.type !== 'multi') return;
    if (input === ' ') {
      const option = options[Math.min(Math.max(0, index), options.length - 1)];
      if (!option) return;
      setSelected((current) => current.includes(option.value) ? current.filter((item) => item !== option.value) : [...current, option.value]);
    } else if (key.return) {
      if (selected.length < (request.min ?? 0) || (request.max !== undefined && selected.length > request.max)) return;
      onReply({ values: selected });
    }
  });

  return (
    <Box borderStyle="round" borderColor={theme.primary} flexDirection="column" paddingX={1}>
      <Text color={theme.primary} bold>需要你的回答 · {request.toolName}</Text>
      <Text>{request.prompt}</Text>
      {request.type === 'choice' && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, optionIndex) => (
            <Text key={`${optionIndex}:${option.value}`} {...(optionIndex === clampedIndex ? { color: theme.primary } : {})}>
              {optionIndex === clampedIndex ? '› ' : '  '}{option.label}
            </Text>
          ))}
          <Text dimColor>↑↓ 移动，Enter 确认</Text>
        </Box>
      )}
      {request.type === 'multi' && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, optionIndex) => (
            <Text key={`${optionIndex}:${option.value}`} {...(optionIndex === clampedIndex ? { color: theme.primary } : {})}>
              {optionIndex === clampedIndex ? '› ' : '  '}{selected.includes(option.value) ? '[x] ' : '[ ] '}{option.label}
            </Text>
          ))}
          <Text dimColor>↑↓ 移动，空格选择，Enter 确认{request.min ? `（至少 ${request.min} 项）` : ''}</Text>
        </Box>
      )}
      {request.type === 'input' && (
        <Box marginTop={1}>
          <Text color={theme.primary}>› </Text>
          <TextInput focus={!disabled} value={value} onChange={setValue} onSubmit={(text) => onReply({ text })} placeholder={request.placeholder ?? ''} />
        </Box>
      )}
    </Box>
  );
}
