export type ResponseLanguage = 'zh-CN' | 'en'

function countHan(text: string): number {
  return text.match(/[\u3400-\u9fff]/g)?.length ?? 0
}

function countLatin(text: string): number {
  return text.match(/[A-Za-z]/g)?.length ?? 0
}

/** Choose the response language from the latest user request, not the model's default. */
export function detectResponseLanguage(text: string): ResponseLanguage {
  const han = countHan(text)
  const latin = countLatin(text)
  return han > 0 && (han >= latin || han >= 2) ? 'zh-CN' : 'en'
}

export function responseLanguageInstruction(language: ResponseLanguage): string {
  return language === 'zh-CN'
    ? 'Reply in Simplified Chinese. Keep code, command names, paths, identifiers, and quoted text unchanged. Do not switch to English unless the user explicitly asks for English.'
    : 'Reply in the same language as the latest user request. Keep code, command names, paths, identifiers, and quoted text unchanged.'
}
