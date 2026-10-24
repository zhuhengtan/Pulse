// Only the independent native page subtree may prove the browser result.
export function nativePreferenceConfirmation(ax, url) {
  const lines = String(ax ?? '').split('\n')
  const address = new URL(url).host + '/'
  const start = lines.findIndex(line => /HTML 内容 Pulse Preferences Acceptance, URL: /.test(line) && line.endsWith(address))
  if (start < 0) return false
  const depth = lines[start].match(/^\s*/)[0].length
  const subtree = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= depth) break
    subtree.push(line)
  }
  const text = subtree.join('\n')
  return /文本栏.*显示名.*Value: Pulse界面复核/.test(text)
    && /复选框.*显示摘要.*Value: 1/.test(text)
    && text.includes('已应用：Pulse界面复核；摘要：开启')
}

export function nativeProfileConfirmation(ax, url) {
 const lines=String(ax??'').split('\n'),address=new URL(url).host+'/'
 const start=lines.findIndex(l=>/HTML 内容 Pulse Browser Acceptance, URL: /.test(l)&&l.endsWith(address))
 if(start<0)return false
 const depth=lines[start].match(/^\s*/)[0].length,subtree=[]
 for(const line of lines.slice(start+1)){
  if(line.trim()&&line.match(/^\s*/)[0].length<=depth)break
  subtree.push(line)
 }
 const text=subtree.join('\n')
 return /文本栏.*Name.*Value: Pulse自主验收/.test(text)&&text.includes('Saved: Pulse自主验收')
}
