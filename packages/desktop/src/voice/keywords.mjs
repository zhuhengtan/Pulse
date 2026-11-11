import { pinyin } from 'pinyin-pro';
// Mixed names such as 小P are often spoken with a Chinese letter reading.
// Keep the English pronunciation too; these aliases only affect local KWS.
const letterReadings = {
  A: ['诶'], B: ['比', '逼'], C: ['西'], D: ['迪', '低'], E: ['伊'], F: ['艾弗'],
  G: ['吉', '鸡'], H: ['诶尺'], I: ['爱'], J: ['杰'], K: ['凯'], L: ['艾尔'],
  M: ['艾姆'], N: ['恩'], O: ['欧'], P: ['皮', '批', '屁'], Q: ['丘'], R: ['阿尔'],
  S: ['艾斯'], T: ['提', '踢'], U: ['优'], V: ['维', '威'], W: ['达布溜'],
  X: ['艾克斯'], Y: ['歪'], Z: ['贼', '泽德'],
};
export function keywordTokens(name, lexicon, tokens) {
  const parts = name.match(/[\p{Script=Han}]|[A-Za-z']+/gu) ?? [];
  if (!parts.length || name.replace(/[\p{Script=Han}A-Za-z'\s-]/gu, '')) throw new Error('名字请使用中文或英文单词');
  const result = [];
  for (const part of parts) {
    if (/\p{Script=Han}/u.test(part)) {
      const initial = pinyin(part, { pattern: 'initial', type: 'array' })[0];
      const final = pinyin(part, { pattern: 'final', toneType: 'symbol', type: 'array' })[0];
      if (initial) result.push(initial); if (final) result.push(final);
    } else {
      const phones = lexicon.get(part.toUpperCase());
      if (!phones) throw new Error(`唤醒词词典中没有 ${part}，请换一个英文单词或使用中文名字`);
      result.push(...phones);
    }
  }
  if (result.some(token => !tokens.has(token))) throw new Error('当前模型不支持这个名字的发音，请更换名字');
  return result.join(' ');
}

export function keywordPronunciations(name, lexicon, tokens) {
  const primary = keywordTokens(name, lexicon, tokens);
  if (!/\p{Script=Han}/u.test(name)) return [primary];
  let aliases = [''];
  for (const part of name.match(/[A-Za-z']+|[^A-Za-z']+/gu) ?? []) {
    const readings = part.length === 1 ? letterReadings[part.toUpperCase()] : undefined;
    aliases = aliases.flatMap(prefix => [part, ...(readings ?? [])].map(value => prefix + value)).slice(0, 16);
  }
  const pronunciations = new Set([primary]);
  for (const alias of aliases) {
    if (alias === name) continue;
    try { pronunciations.add(keywordTokens(alias, lexicon, tokens)); }
    catch { /* Optional Chinese readings must not invalidate a supported name. */ }
  }
  return [...pronunciations];
}
