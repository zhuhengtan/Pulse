/** Split at sentence endings, keeping punctuation/closing quotes and long sentences intact. */
export function speechSentences(text) {
  const result = []; let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!/[。！？!?]/u.test(c) && c !== '.') continue;
    if (c === '.') {
      if (/\d/u.test(text[i - 1] ?? '') && (/\d/u.test(text[i + 1] ?? '') || /^\s*\d+$/u.test(text.slice(start, i)))) continue;
      const word = text.slice(start, i).match(/([\p{L}.]+)$/u)?.[1] ?? '';
      if (/^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|[A-Z]|(?:[A-Z]\.)+[A-Z])$/iu.test(word)) continue;
      if (text[i + 1] && !/[\s。！？!?.”’"'」』）)\]】]/u.test(text[i + 1])) continue;
    }
    while (i + 1 < text.length && /[。！？!?.… ”’"'」』）)\]】]/u.test(text[i + 1])) i++;
    const sentence = text.slice(start, i + 1).trim(); if (sentence) result.push(sentence);
    start = i + 1;
  }
  const tail = text.slice(start).trim(); if (tail) result.push(tail);
  return result;
}
