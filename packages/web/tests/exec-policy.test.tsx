import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { ExecPolicyEditor, execPolicyDraftValid } from '../src/ExecPolicyEditor.js'
import { InteractionPanel, type PendingInteraction } from '../src/InteractionPanel.js'

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList
})
afterEach(() => { cleanup(); localStorage.clear() })
const openRule = (view: ReturnType<typeof render>, index = 1) => { fireEvent.click(view.getByRole('button', { name: /^全部/ })); fireEvent.click(view.getByRole('button', { name: `编辑规则 ${index}` })) }
const openHosts = (view: ReturnType<typeof render>) => fireEvent.click(view.getByText('受信程序路径'))
const interaction: PendingInteraction = { kind: 'interaction', runId: 'r', groupId: 'g', interactionKind: 'approval', items: [{ effectId: 'e', input: { tools: [{ toolName: 'shell.exec', details: { command: 'git', args: ['status'] } }], execPolicy: { token: 'server-offer', prefix: ['git', 'status'], canAmend: true, scope: 'run' } } }] }
it.each(['session', 'permanent'] as const)('submits only the %s choice and backend offer token from a local approval', async choice => {
  const submit = vi.fn(async () => true)
  const view = render(<InteractionPanel localAdmin interaction={interaction} reviewNote="" delegated={false} submit={submit}/>)
  fireEvent.click(view.getByRole('button', { name: choice === 'session' ? /本次任务记住/ : /永久记住/ }))
  await waitFor(() => expect(submit).toHaveBeenCalledWith([{ effectId: 'e', value: { approved: true, remember: choice, execPolicyToken: 'server-offer' } }]))
})
it('does not display host authority buttons on a remote session', () => {
  const view = render(<InteractionPanel interaction={interaction} reviewNote="" delegated={false} submit={async () => true}/>)
  expect(view.queryByRole('button', { name: /记住/ })).toBeNull()
  expect(view.getByRole('button', { name: '允许本次' })).toBeTruthy()
})
it('does not offer remember for an explicit prompt without a backend offer', () => {
  const item = structuredClone(interaction); delete item.items[0]!.input.execPolicy
  const view = render(<InteractionPanel localAdmin interaction={item} reviewNote="" delegated={false} submit={async () => true}/>)
  expect(view.queryByRole('button', { name: /记住/ })).toBeNull()
})
it('edits structured token alternatives and validates a draft through the diagnostic endpoint', async () => {
  const change = vi.fn(), request = vi.fn(async () => new Response(JSON.stringify({ decision: 'forbidden', reason: 'exec_policy_forbidden', version: 'v1', resolvedProgram: '/usr/bin/git', matchedRules: [{ source: 'host', index: 0 }] })))
  const config = { execPolicy: { rules: [{ id: 'r1', pattern: ['git', 'status'], decision: 'prompt' }], hostExecutables: { git: ['/usr/bin/git'] } } }
  const view = render(<ExecPolicyEditor config={config} onChange={change} transport={{ request, subscribe: () => () => {} }}/>)
  openRule(view)
  fireEvent.change(view.getByRole('textbox', { name: '规则 1 Token 1' }), { target: { value: 'status | diff' } })
  expect(change.mock.calls.at(-1)![0].execPolicy.rules[0].pattern).toEqual(['git', ['status', 'diff']])
  fireEvent.click(view.getByRole('button', { name: '完成编辑' }))
  fireEvent.click(view.getByText('命令策略测试器'))
  fireEvent.click(view.getByRole('button', { name: '测试匹配' }))
  await waitFor(() => expect(view.getByRole('status').textContent).toContain('forbidden'))
  const [path, init] = request.mock.calls[0] as unknown as [string, RequestInit]
  expect(path).toBe('/api/config/exec-policy/check')
  expect(init.method).toBe('POST')
  expect(JSON.parse(String(init.body))).toMatchObject({ argv: ['git', 'status', '--short'], execPolicy: config.execPolicy })
})
it('reports invalid example drafts so save can be blocked instead of silently saving an old example', () => {
  const valid = vi.fn(), change = vi.fn()
  const view = render(<ExecPolicyEditor config={{ execPolicy: { rules: [{ id: 'r', pattern: ['git'], decision: 'prompt' }] } }} onChange={change} onValidityChange={valid} transport={{ request: vi.fn(), subscribe: () => () => {} }}/>)
  openRule(view)
  fireEvent.change(view.getByRole('textbox', { name: '规则 1 必须匹配示例' }), { target: { value: 'git status' } })
  expect(valid).toHaveBeenLastCalledWith(false); expect(change.mock.calls.at(-1)![0].execPolicy.rules[0].match).toBe('git status')
  fireEvent.change(view.getByRole('textbox', { name: '规则 1 必须匹配示例' }), { target: { value: '["git","status"]' } })
  expect(valid).toHaveBeenLastCalledWith(true)
})
const transport = { request: vi.fn(), subscribe: () => () => {} }
it('does not keep an illegal example after the saved draft is restored', () => {
  const valid = vi.fn()
  const saved = { execPolicy: { rules: [{ id: 'r', pattern: ['git'], decision: 'prompt', match: [['git', 'status']] }] } }
  const view = render(<ExecPolicyEditor revision={1} config={saved} onChange={vi.fn()} onValidityChange={valid} transport={transport}/>)
  openRule(view)
  const illegal = { execPolicy: { rules: [{ id: 'r', pattern: ['git'], decision: 'prompt', match: 'git status' }] } }
  view.rerender(<ExecPolicyEditor revision={1} config={illegal} onChange={vi.fn()} onValidityChange={valid} transport={transport}/>)
  expect((view.getByRole('textbox', { name: '规则 1 必须匹配示例' }) as HTMLTextAreaElement).value).toBe('git status')
  expect(valid).toHaveBeenLastCalledWith(false)
  expect(execPolicyDraftValid(illegal)).toBe(false)
  view.rerender(<ExecPolicyEditor revision={2} config={saved} onChange={vi.fn()} onValidityChange={valid} transport={transport}/>)
  openRule(view)
  expect((view.getByRole('textbox', { name: '规则 1 必须匹配示例' }) as HTMLTextAreaElement).value).toBe('["git","status"]')
  expect(valid).toHaveBeenLastCalledWith(true)
  expect(execPolicyDraftValid(saved)).toBe(true)
})
it('does not reuse an invalid example when an id-less rule is deleted', () => {
  const change = vi.fn()
  const config = { execPolicy: { rules: [{ pattern: ['git', 'status'], decision: 'prompt', match: [['git', 'status']] }, { pattern: ['node', '--version'], decision: 'prompt', match: [['node', '--version']] }] } }
  const view = render(<ExecPolicyEditor config={config} onChange={change} transport={transport}/>)
  openRule(view)
  fireEvent.change(view.getByRole('textbox', { name: '规则 1 必须匹配示例' }), { target: { value: 'not-json' } })
  fireEvent.click(view.getAllByRole('button', { name: '删除规则' })[0]!)
  view.rerender(<ExecPolicyEditor config={change.mock.calls.at(-1)![0]} onChange={change} transport={transport}/>)
  openRule(view)
  expect((view.getByRole('textbox', { name: '规则 1 必须匹配示例' }) as HTMLTextAreaElement).value).toBe('["node","--version"]')
})
it('keeps a duplicate program name unsaved and does not overwrite another mapping', () => {
  const change = vi.fn(), valid = vi.fn(), localDraft = vi.fn()
  const view = render(<ExecPolicyEditor config={{ execPolicy: { hostExecutables: { program1: ['/usr/bin/git'], program2: ['/bin/git'] } } }} onChange={change} onValidityChange={valid} onLocalDraftChange={localDraft} transport={transport}/>)
  openHosts(view)
  fireEvent.change(view.getByRole('textbox', { name: '路径映射 1 程序名' }), { target: { value: 'program2' } })
  expect(valid).toHaveBeenLastCalledWith(false)
  expect(localDraft).toHaveBeenLastCalledWith(true)
  expect(change).not.toHaveBeenCalled()
  expect((view.getByRole('textbox', { name: '路径映射 1 程序名' }) as HTMLInputElement).value).toBe('program2')
  expect((view.getByRole('textbox', { name: '路径映射 1 受信路径' }) as HTMLTextAreaElement).value).toBe('/usr/bin/git')
  expect((view.getByRole('textbox', { name: '路径映射 2 受信路径' }) as HTMLTextAreaElement).value).toBe('/bin/git')
  view.rerender(<ExecPolicyEditor revision={1} config={{ execPolicy: { hostExecutables: { program1: ['/usr/bin/git'], program2: ['/bin/git'] } } }} onChange={change} onValidityChange={valid} transport={transport}/>)
  expect((view.getByRole('textbox', { name: '路径映射 1 程序名' }) as HTMLInputElement).value).toBe('program1')
  expect(valid).toHaveBeenLastCalledWith(true)
})
it('allocates an unused program name instead of clearing an existing path mapping', () => {
  const change = vi.fn()
  const view = render(<ExecPolicyEditor config={{ execPolicy: { hostExecutables: { program1: ['/usr/bin/git'], program2: ['/bin/git'] } } }} onChange={change} transport={transport}/>)
  openHosts(view)
  fireEvent.click(view.getAllByRole('button', { name: '移除路径映射' })[0]!)
  view.rerender(<ExecPolicyEditor config={change.mock.calls.at(-1)![0]} onChange={change} transport={transport}/>)
  fireEvent.click(view.getByRole('button', { name: '添加路径映射' }))
  const hosts = change.mock.calls.at(-1)![0].execPolicy.hostExecutables
  expect(hosts.program2).toEqual(['/bin/git'])
  expect(hosts.program1).toEqual([])
  expect(hosts.program3).toBeUndefined()
})

it('starts with a searchable granted-command list and edits only the selected rule', () => {
  const change = vi.fn()
  const view = render(<ExecPolicyEditor config={{ execPolicy: { rules: [
    { pattern: ['git', 'status', '--short'], decision: 'allow', binding: { cwd: '/workspace/demo', fingerprint: 'version' } },
    { pattern: ['node', '--version'], decision: 'allow' },
    { pattern: ['git', 'push'], decision: 'prompt' },
  ] } }} onChange={change} transport={transport}/>)
  expect(view.getByRole('table').textContent).toContain('git status --short')
  expect(view.getByRole('table').textContent).toContain('/workspace/demo')
  expect(view.getByRole('table').textContent).not.toContain('git push')
  expect(view.queryByRole('textbox', { name: '规则 1 Token 0' })).toBeNull()
  fireEvent.change(view.getByRole('textbox', { name: '搜索命令' }), { target: { value: 'node' } })
  expect(view.getByRole('table').textContent).not.toContain('git status')
  fireEvent.click(view.getByRole('button', { name: '撤销授权 node --version' }))
  expect(change.mock.calls.at(-1)![0].execPolicy.rules.map((r: any) => r.pattern.join(' '))).toEqual(['git status --short', 'git push'])
})
