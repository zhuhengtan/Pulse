import { Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { mouseEvent } from '../utils/mouse.js';
import { stripTerminalControls } from '../utils/ansi.js';

interface Props { value: string; onChange: (value: string) => void; focus?: boolean; placeholder?: string }
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Keep global control shortcuts out of editable text, including on Mac terminals. */
export default function TextInput({ value, onChange, focus = true, placeholder = '' }: Props) {
  const [position, setPosition] = useState<number | null>(null);
  const editing = useRef({ value, position });
  editing.current = { value, position };
  const characters = Array.from(segmenter.segment(value), (part) => part.segment);
  const cursor = position === null ? characters.length : Math.min(position, characters.length);
  useInput((input, key) => {
    const characters = Array.from(segmenter.segment(editing.current.value), (part) => part.segment);
    const cursor = editing.current.position === null ? characters.length : Math.min(editing.current.position, characters.length);
    const move = (next: number | null) => { editing.current.position = next; setPosition(next); };
    if (mouseEvent(input)) return;
    if (key.ctrl || key.meta || key.pageUp || key.pageDown || key.upArrow || key.downArrow || key.tab || key.escape || key.return) return;
    if (key.leftArrow || key.rightArrow || key.home || key.end) {
      move(key.home ? 0 : key.end ? null : Math.max(0, Math.min(characters.length, cursor + (key.leftArrow ? -1 : 1))));
      return;
    }
    const next = [...characters];
    if (key.backspace || key.delete) {
      if (!cursor) return;
      next.splice(cursor - 1, 1);
      move(cursor - 1 === next.length ? null : cursor - 1);
    } else {
      const inserted = Array.from(segmenter.segment(stripTerminalControls(input)), (part) => part.segment);
      if (!inserted.length) return;
      next.splice(cursor, 0, ...inserted);
      move(cursor === characters.length ? null : cursor + inserted.length);
    }
    editing.current.value = next.join('');
    onChange(editing.current.value);
  }, { isActive: focus });
  if (!value) return <Text dimColor>{focus ? <Text inverse>{placeholder.slice(0, 1) || ' '}</Text> : null}{focus ? placeholder.slice(1) : placeholder}</Text>;
  return <Text>{characters.slice(0, cursor).join('')}{focus ? <Text inverse>{characters[cursor] || ' '}</Text> : characters[cursor]}{characters.slice(cursor + 1).join('')}</Text>;
}
