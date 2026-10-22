export function browserAddress(value: string): string {
  const text = value.trim()
  if (!text) throw new Error('请输入网址。')
  const address = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http${/^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(text) ? '' : 's'}://${text}`)
  if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('请输入 HTTP 或 HTTPS 网址。')
  return address.href
}
