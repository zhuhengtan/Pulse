import './exec-policy.css'
import { Drawer } from 'antd'
import { PlusOutlined, SearchOutlined } from '@ant-design/icons'
import { useEffect, useRef, useState } from 'react'
import { PulseButton, PulseInput, PulseSelect, PulseTextArea } from './PulseControls.js'
import { apiJson, jsonRequest, type PulseWebTransport } from './transport.js'

type Obj = Record<string, any>
const object = (v: unknown): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v as Obj : {}
function examplesFieldValid(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every(row => Array.isArray(row) && row.length > 0 && row.every(cell => typeof cell === 'string' && cell.length > 0))
}
/** Illegal example text stays unsavable after cancel, reload, or advanced JSON edits. */
export function execPolicyDraftValid(config: unknown): boolean {
  const root = object(config)
  if (root.execPolicy === undefined) return true
  const policy = object(root.execPolicy)
  if (root.execPolicy !== policy) return false
  const rules = Array.isArray(policy.rules) ? policy.rules : []
  if (!rules.every((rule: Obj) => examplesFieldValid(rule?.match) && examplesFieldValid(rule?.notMatch))) return false
  if (policy.hostExecutables === undefined) return true
  const hosts = object(policy.hostExecutables)
  if (policy.hostExecutables !== hosts) return false
  const names = Object.keys(hosts)
  return names.every(name => name.trim().length > 0) && new Set(names).size === names.length
}
function parseExamples(text: string): { ok: true; rows: string[][] } | { ok: false } {
  if (!text.trim()) return { ok: true, rows: [] }
  try {
    const rows = text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line) as unknown)
    if (rows.some(row => !Array.isArray(row) || !row.length || row.some(cell => typeof cell !== 'string' || !cell))) return { ok: false }
    return { ok: true, rows: rows as string[][] }
  } catch { return { ok: false } }
}
function exampleText(value: string[][] | string): string {
  return typeof value === 'string' ? value : value.map(row => JSON.stringify(row)).join('\n')
}
function Examples({ label, value, onChange, onInvalid }: { label: string; value: string[][] | string; onChange: (v: string[][] | string) => void; onInvalid: (v: boolean) => void }) {
  const external = exampleText(value)
  const [text, setText] = useState(external)
  const [seen, setSeen] = useState(external)
  const [error, setError] = useState('')
  if (seen !== external) {
    const parsed = parseExamples(external)
    setSeen(external)
    setText(external)
    setError(parsed.ok ? '' : '每行填写一个非空 argv 字符串数组；此无效草稿必须修正后才能保存。')
  }
  const reportInvalid = useRef(onInvalid)
  reportInvalid.current = onInvalid
  useEffect(() => { reportInvalid.current(!parseExamples(text).ok) }, [text])
  return <label>{label}<PulseTextArea aria-label={label} rows={2} value={text} placeholder={'["git","status","--short"]'} onChange={e => {
    const next = e.target.value
    setText(next)
    const parsed = parseExamples(next)
    if (parsed.ok) { onChange(parsed.rows); setError(''); onInvalid(false) }
    else { onChange(next); onInvalid(true); setError('每行填写一个非空 argv 字符串数组；此无效草稿必须修正后才能保存。') }
  }} />{error && <span role="alert">{error}</span>}</label>
}

type HostRow = { key: string; name: string; paths: string }
function rowsFrom(hosts: Obj): HostRow[] {
  return Object.entries(hosts).map(([name, paths]) => ({ key: crypto.randomUUID(), name, paths: Array.isArray(paths) ? (paths as string[]).join('\n') : '' }))
}
function namesValid(rows: HostRow[]): boolean {
  const names = rows.map(row => row.name.trim())
  return names.every(Boolean) && new Set(names).size === names.length
}
function unusedProgramName(rows: HostRow[]): string {
  const used = new Set(rows.map(row => row.name.trim()))
  let index = 1
  while (used.has(`program${index}`)) index += 1
  return `program${index}`
}

export function ExecPolicyEditor({ config, onChange, transport, onValidityChange, onLocalDraftChange, revision = 0 }: { config: Obj; onChange: (v: Obj) => void; transport: PulseWebTransport; onValidityChange?: (valid: boolean) => void; onLocalDraftChange?: (pending: boolean) => void; revision?: number }) {
  const invalid = useRef(new Set<string>())
  const report = (key: string, bad: boolean) => { if (bad) invalid.current.add(key); else invalid.current.delete(key); onValidityChange?.(invalid.current.size === 0) }
  const policy = object(config.execPolicy), rules: Obj[] = Array.isArray(policy.rules) ? policy.rules : [], hosts = object(policy.hostExecutables)
  const [argv, setArgv] = useState('["git","status","--short"]'), [cwd, setCwd] = useState('.'), [result, setResult] = useState<Obj>(), [error, setError] = useState(''), [testing, setTesting] = useState(false)
  const [hostRows, setHostRows] = useState<HostRow[]>(() => rowsFrom(hosts))
  const [rowKeys, setRowKeys] = useState<string[]>(() => rules.map(() => crypto.randomUUID()))
  const [seenRevision, setSeenRevision] = useState(revision)
  const [filter, setFilter] = useState('allow'), [search, setSearch] = useState(''), [editing, setEditing] = useState<string | null>(null)
  if (seenRevision !== revision) {
    invalid.current.clear()
    setSeenRevision(revision)
    setEditing(null)
    setHostRows(rowsFrom(hosts))
    setRowKeys(rules.map(() => crypto.randomUUID()))
  }
  const keys = rowKeys.length === rules.length ? rowKeys : rules.map((_, index) => rowKeys[index] ?? `rule-${revision}-${index}`)
  const update = (patch: Obj) => { onChange({ ...config, execPolicy: { ...policy, ...patch } }); setResult(undefined) }
  const rule = (i: number, patch: Obj) => update({ rules: rules.map((item, index) => index === i ? { ...item, ...patch } : item) })
  const localDraft = useRef(onLocalDraftChange)
  localDraft.current = onLocalDraftChange
  const commitHosts = (next: HostRow[]) => {
    setHostRows(next)
    const pending = !namesValid(next)
    report('hosts', pending)
    localDraft.current?.(pending)
    // An illegal name stays local. Writing it into the object would collapse or erase another mapping.
    if (pending) return
    update({ hostExecutables: Object.fromEntries(next.map(row => [row.name.trim(), row.paths.split('\n').map(item => item.trim()).filter(Boolean)])) })
  }
  useEffect(() => {
    const pending = !namesValid(hostRows)
    report('hosts', pending)
    localDraft.current?.(pending)
  }, [hostRows])
  const commandText = (r: Obj) => (Array.isArray(r.pattern) ? r.pattern : []).map((part: string | string[]) => Array.isArray(part) ? `{${part.join(' | ')}}` : /\s/.test(part) ? JSON.stringify(part) : part).join(' ')
  const active = editing === null ? -1 : keys.indexOf(editing)
  const visible = rules.map((r, i) => ({ r, i })).filter(({ r }) => (filter === 'all' || r.decision === filter) && `${commandText(r)} ${r.justification ?? ''} ${r.binding?.cwd ?? ''}`.toLowerCase().includes(search.toLowerCase()))
  const removeRule = (i: number) => { report(`${keys[i]}:match`, false); report(`${keys[i]}:notMatch`, false); if (editing === keys[i]) setEditing(null); setRowKeys(keys.filter((_, index) => index !== i)); update({ rules: rules.filter((_, index) => index !== i) }) }
  return <div className="specialized-editor exec-policy-editor">
    <section className="exec-policy-main" aria-label="命令授权列表">
      <header className="exec-policy-heading"><div><h2>命令授权</h2><p>查看和管理已保存的命令规则。</p></div><PulseButton className="exec-policy-add" onClick={() => { const key = crypto.randomUUID(); setRowKeys([...keys, key]); update({ rules: [...rules, { id: crypto.randomUUID(), pattern: ['git', 'status'], decision: 'prompt' }] }); setEditing(key) }}><PlusOutlined/>添加命令规则</PulseButton></header>
      <div className="exec-policy-toolbar"><div className="exec-policy-filters" role="group" aria-label="规则筛选">{[['allow', '已放行'], ['prompt', '每次确认'], ['forbidden', '已禁止'], ['all', '全部']].map(([value, label]) => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value!)}>{label}<span>{value === 'all' ? rules.length : rules.filter(r => r.decision === value).length}</span></button>)}</div><PulseInput className="exec-policy-search" prefix={<SearchOutlined/>} aria-label="搜索命令" placeholder="搜索命令或目录" value={search} onChange={e => setSearch(e.target.value)}/></div>
      <div className="exec-policy-table-wrap"><table className="exec-policy-table"><thead><tr><th>命令</th><th>匹配方式</th><th>作用范围</th><th><span className="exec-policy-sr-only">操作</span></th></tr></thead><tbody>
        {visible.map(({ r, i }) => <tr key={keys[i]}><td data-label="命令"><code>{commandText(r) || '未填写命令'}</code><div className="exec-policy-row-caption"><span className={`exec-policy-dot ${r.decision}`}/>{r.decision === 'allow' ? '允许' : r.decision === 'forbidden' ? '禁止执行' : '每次人工确认'}<span>·</span>{r.binding ? '审批记住' : '手动规则'}{r.justification && <span>· {r.justification}</span>}</div></td><td data-label="匹配方式"><span>{r.binding ? '完整参数' : '命令前缀'}</span>{r.binding && <small>绑定同版本程序</small>}</td><td data-label="作用范围"><span>{r.binding ? '指定目录' : '宿主配置'}</span><small title={r.binding?.cwd}>{r.binding?.cwd ?? '仍受工作区与权限限制'}</small></td><td className="exec-policy-row-actions"><PulseButton aria-label={`编辑规则 ${i + 1}`} onClick={() => setEditing(keys[i]!)}>编辑</PulseButton><PulseButton className="exec-policy-revoke" aria-label={`${r.decision === 'allow' ? '撤销授权' : '删除规则'} ${commandText(r)}`} onClick={() => removeRule(i)}>{r.decision === 'allow' ? '撤销' : '删除'}</PulseButton></td></tr>)}
      </tbody></table>{visible.length === 0 && <div className="exec-policy-empty"><strong>{search ? '没有匹配的命令' : filter === 'allow' ? '还没有保存放行命令' : '暂无此类规则'}</strong><p>{search ? '换个关键词试试。' : '审批时选择“永久记住”，命令会显示在这里。'}</p></div>}</div>
      <p className="exec-policy-footnote">禁止和“每次确认”优先于允许；列表中的允许规则仍受这些限制。撤销后需点击“保存全部”生效。</p>
      <p className="exec-policy-footnote">“本次任务记住”仅在对应任务中有效，结束或重启即失效，不写入此永久配置列表。</p>
    </section>
    <Drawer title="编辑命令规则" open={active >= 0} onClose={() => setEditing(null)} size={560} rootClassName="exec-policy-drawer" footer={<PulseButton onClick={() => setEditing(null)}>完成编辑</PulseButton>}>
      {active >= 0 && (() => { const i = active, r = rules[i]!; return <div className="exec-policy-rule-form">
        <label>决策<PulseSelect aria-label={`规则 ${i + 1} 决策`} value={r.decision ?? 'prompt'} onChange={decision => rule(i, { decision })}><option value="allow">允许</option><option value="prompt">每次人工确认</option><option value="forbidden">禁止执行</option></PulseSelect></label>
        <div>{(Array.isArray(r.pattern) ? r.pattern : ['']).map((part: string | string[], n: number) => <label key={n}>{n === 0 ? '程序名或绝对路径' : `参数 ${n}（候选值用 | 分隔）`}<PulseInput aria-label={`规则 ${i + 1} Token ${n}`} value={Array.isArray(part) ? part.join(' | ') : part} onChange={e => { const pattern = [...r.pattern]; const values = e.target.value.split('|').map(s => s.trim()); pattern[n] = n > 0 && values.length > 1 ? values : e.target.value; rule(i, { pattern }) }} />{n > 0 && <PulseButton onClick={() => rule(i, { pattern: r.pattern.filter((_: unknown, k: number) => k !== n) })}>移除参数</PulseButton>}</label>)}</div>
        <PulseButton onClick={() => rule(i, { pattern: [...r.pattern, ''] })}>添加参数</PulseButton>
        <label>说明<PulseInput aria-label={`规则 ${i + 1} 说明`} value={r.justification ?? ''} onChange={e => rule(i, { justification: e.target.value })}/></label>
        {r.binding && <p>记住的授权：仅适用于原工作目录、同版本程序和当时的完整参数。可删除此规则撤销。</p>}
        <Examples label={`规则 ${i + 1} 必须匹配示例`} value={r.match ?? []} onChange={match => rule(i, { match })} onInvalid={bad => report(`${keys[i]}:match`, bad)}/>
        <Examples label={`规则 ${i + 1} 必须不匹配示例`} value={r.notMatch ?? []} onChange={notMatch => rule(i, { notMatch })} onInvalid={bad => report(`${keys[i]}:notMatch`, bad)}/>
        <PulseButton onClick={() => { report(`${keys[i]}:match`, false); report(`${keys[i]}:notMatch`, false); setEditing(null); setRowKeys(keys.filter((_, index) => index !== i)); update({ rules: rules.filter((_, index) => index !== i) }) }}>删除规则</PulseButton>

      </div> })()}
    </Drawer>
    <details className="exec-policy-advanced"><summary><span>受信程序路径</span><span>配置同名程序的真实位置</span></summary><div className="exec-policy-detail-body"><p>普通 allow 规则必须绑定真实解析后的程序路径，未登记的同名程序不会自动继承授权。诊断结果会显示实际路径。</p>
      {hostRows.map((row, index) => <div className="exec-policy-host-row" key={row.key}><label>程序名<PulseInput aria-label={`路径映射 ${index + 1} 程序名`} value={row.name} onChange={e => commitHosts(hostRows.map(item => item.key === row.key ? { ...item, name: e.target.value } : item))} /></label><PulseTextArea aria-label={`路径映射 ${index + 1} 受信路径`} rows={2} value={row.paths} onChange={e => commitHosts(hostRows.map(item => item.key === row.key ? { ...item, paths: e.target.value } : item))} /><PulseButton onClick={() => commitHosts(hostRows.filter(item => item.key !== row.key))}>移除路径映射</PulseButton></div>)}
      <PulseButton onClick={() => commitHosts([...hostRows, { key: crypto.randomUUID(), name: unusedProgramName(hostRows), paths: '' }])}>添加路径映射</PulseButton>
    </div></details>
    <details className="exec-policy-advanced"><summary><span>命令策略测试器</span><span>检查规则，不运行命令</span></summary><div className="exec-policy-detail-body"><p>只检查当前草稿，不运行命令；输入 argv 数组，保留每个参数的原始边界。保存时会校验全部规则与示例；后台授权写入造成版本冲突时需重载并重新合并。</p>
      <label>argv<PulseTextArea aria-label="命令 argv" value={argv} onChange={e => setArgv(e.target.value)}/></label><label>工作目录<PulseInput aria-label="策略测试工作目录" value={cwd} onChange={e => setCwd(e.target.value)}/></label>
      <PulseButton disabled={testing} onClick={() => { setTesting(true); setError(''); void (async () => { try { setResult(await apiJson(transport, '/api/config/exec-policy/check', jsonRequest('POST', { argv: JSON.parse(argv), cwd, execPolicy: policy }))) } catch (cause) { setResult(undefined); setError(cause instanceof Error ? cause.message : '检查失败') } finally { setTesting(false) } })() }}>测试匹配</PulseButton>
      {error && <p role="alert">{error}</p>}{result && <div role="status"><p>决策：{result.decision} · {result.reason}</p><p>实际程序：{result.resolvedProgram ?? '无法解析'}；配置版本：{result.version}</p><pre>{JSON.stringify(result.matchedRules, null, 2)}</pre></div>}
    </div></details>
  </div>
}
