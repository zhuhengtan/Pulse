import { Box, Text, useInput } from 'ink';
import TextInput from './TextInput.js';
import { useRef, useState } from 'react';
import { theme } from '../theme.js';
import type { AskRequest } from '../types.js';

interface Props {
  request: AskRequest;
  disabled?: boolean;
  onReply: (value: Record<string, unknown>) => void;
  onCancel?: () => void;
}

/** Typed text that cancels the pending question instead of choosing an option. */
const CANCEL_COMMAND = /^\/?\s*(?:cancel|quit|exit)\s*$/i;

export function AskPrompt({ request, disabled = false, onReply, onCancel }: Props) {
  const [value, setValue] = useState(request.defaultValue ?? '');
  const [inputLines, setInputLines] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [typed, setTyped] = useState('');
  // Mirror of `typed` that updates synchronously, so an Enter arriving in the
  // same batch as a multi-character paste still sees the buffered text.
  const typedRef = useRef('');
  const [hint, setHint] = useState<string | null>(null);
  const updateTyped = (next: (current: string) => string) => {
    const value = next(typedRef.current);
    typedRef.current = value;
    setTyped(value);
  };
  const options = request.options ?? [];
  const clampedIndex = options.length === 0 ? 0 : Math.min(Math.max(0, index), options.length - 1);
  const isList = request.type === 'choice' || request.type === 'multi';

  useInput((input, key) => {
    if (disabled) return;
    if (request.type === 'input' && key.return) {
      if (key.shift) {
        setInputLines((current) => [...current, value]);
        setValue('');
      } else {
        onReply({ text: [...inputLines, value].join('\n') });
      }
      return;
    }
    if (!isList || options.length === 0) return;
    // Escape already cancels the whole run at the app level; here we add an
    // explicit, text-level cancel so Enter never confirms the default option
    // by accident after the user typed /cancel.
    if (key.upArrow) {
      setIndex((current) => Math.max(0, current - 1));
      return;
    }
    if (key.downArrow) {
      setIndex((current) => Math.min(options.length - 1, current + 1));
      return;
    }
    if (key.backspace || key.delete) {
      updateTyped((current) => current.slice(0, -1));
      setHint(null);
      return;
    }
    if (request.type === 'multi' && input === ' ') {
      const option = options[clampedIndex];
      if (!option) return;
      setSelected((current) => current.includes(option.value) ? current.filter((item) => item !== option.value) : [...current, option.value]);
      return;
    }
    if (key.return) {
      const pending = typedRef.current.trim();
      if (pending) {
        if (CANCEL_COMMAND.test(pending)) { onCancel?.(); return; }
        // A pending line of text must never turn Enter into a silent default
        // selection: clear it and ask the user to choose deliberately.
        updateTyped(() => '');
        setHint('未提交选择：请用 ↑↓ 移动后按 Enter 确认；如需取消请输入 /cancel 或按 Esc。');
        return;
      }
      if (request.type === 'choice') {
        const option = options[clampedIndex];
        if (option) onReply({ value: option.value });
        return;
      }
      if (selected.length < (request.min ?? 0) || (request.max !== undefined && selected.length > request.max)) return;
      onReply({ values: selected });
      return;
    }
    // Buffer the whole printable segment so pasted text such as /cancel is
    // recognised without a dedicated box.
    if (!key.ctrl && !key.meta) {
      const printable = input.replace(/[\x00-\x1f\x7f]/g, '');
      if (printable) {
        updateTyped((current) => Array.from(current + printable).slice(-32).join(''));
        setHint(null);
      }
    }
  });

  return (
    <Box borderStyle="double" borderColor={theme.primary} flexDirection="column" paddingX={1} marginTop={1}>
      <Text color={theme.primary} bold>✦ 需要你的回答 · {request.toolName}</Text>
      <Text color="white">{request.prompt}</Text>
      {hint ? <Text color="yellow">{hint}</Text> : null}
      {isList && typed ? <Text color="yellow">已输入：{typed}</Text> : null}
      {request.type === 'choice' && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, optionIndex) => (
            <Text key={`${optionIndex}:${option.value}`} {...(optionIndex === clampedIndex ? { color: theme.primary } : {})}>
              {optionIndex === clampedIndex ? '› ' : '  '}{option.label}
            </Text>
          ))}
          <Text dimColor>↑↓ 移动，Enter 确认；Esc 或输入 /cancel 取消</Text>
        </Box>
      )}
      {request.type === 'multi' && (
        <Box flexDirection="column" marginTop={1}>
          {options.map((option, optionIndex) => (
            <Text key={`${optionIndex}:${option.value}`} {...(optionIndex === clampedIndex ? { color: theme.primary } : {})}>
              {optionIndex === clampedIndex ? '› ' : '  '}{selected.includes(option.value) ? '[x] ' : '[ ] '}{option.label}
            </Text>
          ))}
          <Text dimColor>↑↓ 移动，空格选择，Enter 确认{request.min ? `（至少 ${request.min} 项）` : ''}；Esc 或输入 /cancel 取消</Text>
        </Box>
      )}
      {request.type === 'input' && (
        <Box flexDirection="column" marginTop={1}>
          {inputLines.map((line, lineIndex) => (
            <Box key={`${lineIndex}:${line}`}>
              <Text color={theme.primary}>› </Text>
              <Text>{line}</Text>
            </Box>
          ))}
          <Box>
            <Text color={theme.primary}>› </Text>
            <TextInput focus={!disabled} value={value} onChange={setValue} placeholder={request.placeholder ?? ''} />
          </Box>
        </Box>
      )}
    </Box>
  );
}
