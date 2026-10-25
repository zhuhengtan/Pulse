import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SkillManager } from '../src/SkillManager.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }) })
afterEach(cleanup)
const detail = { name: 'demo', description: '示例技能', content: '---\nname: demo\n---\nSkill body', warnings: [], files: [{ path: 'SKILL.md', bytes: 100 }, { path: 'scripts/run.mjs', bytes: 20 }], compatibility: 'Node.js', origin: { repository: 'owner/repo', directory: 'skills/demo', commit: 'a'.repeat(40), ref: 'HEAD' } }
function fixture(fail = false) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  let installed = false
  const transport: PulseWebTransport = {
    subscribe: () => () => {},
    request: vi.fn(async (path, init) => {
      const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (path.endsWith('/installed')) return respond({ skills: [{ name: 'skill-creator', description: '创建技能', builtin: true }, ...(installed ? [{ name: 'demo', description: '示例技能', managed: true, origin: detail.origin }] : [])] })
      if (path.includes('/search?')) return fail ? respond({ error: 'SKILL_REMOTE_RATE_LIMITED' }, 400) : respond({ skills: [{ id: 'owner/repo/demo', name: 'demo', source: 'owner/repo', installs: 1200 }] })
      if (path.endsWith('/inspect')) return respond({ previewId: 'preview', skills: [detail] })
      if (path.endsWith('/install')) { writes.push({ path, body: JSON.parse(String(init?.body)) }); installed = true; return respond({ name: 'demo' }) }
      if (path.includes('/detail?')) return respond({ ...detail, name: 'skill-creator', builtin: true })
      return respond({ error: 'NOT_FOUND' }, 404)
    }),
  }
  return { transport, writes }
}
function mount(transport: PulseWebTransport, blocked = false, changed = vi.fn(async () => {})) { render(<PulseDesignSystem><SkillManager transport={transport} configVersion="version" blocked={blocked} onChanged={changed}/></PulseDesignSystem>); return changed }

describe('skill manager', () => {
  it('searches, previews and installs the exact selected skill then refreshes', async () => {
    const { transport, writes } = fixture(), changed = mount(transport)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    fireEvent.click(await screen.findByRole('button', { name: '查看详情' }))
    await screen.findByText('环境要求：Node.js')
    expect(screen.getByText('scripts/run.mjs')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '安装并启用' }))
    await screen.findByText('技能已安装并启用，可在输入框键入 / 后选择。')
    expect(writes).toEqual([{ path: '/api/skill-marketplace/install', body: { previewId: 'preview', name: 'demo', directory: 'skills/demo', configVersion: 'version' } }])
    expect(changed).toHaveBeenCalledOnce()
  })
  it('keeps direct repository inspection available when search is rate limited', async () => {
    const { transport } = fixture(true); mount(transport)
    fireEvent.change(screen.getByRole('textbox', { name: '搜索技能' }), { target: { value: 'demo' } })
    fireEvent.click(screen.getByRole('button', { name: '搜索' }))
    await screen.findByText('平台请求过多，请稍后重试。')
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub 技能仓库地址' }), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: '查看仓库' }))
    await screen.findByRole('button', { name: '安装并启用' })
  })
  it('protects unsaved configuration and built-in skills', async () => {
    const { transport, writes } = fixture(); mount(transport, true)
    fireEvent.change(screen.getByRole('textbox', { name: 'GitHub 技能仓库地址' }), { target: { value: 'owner/repo' } })
    fireEvent.click(screen.getByRole('button', { name: '查看仓库' }))
    expect((await screen.findByRole('button', { name: '安装并启用' })).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: '已安装' }))
    await screen.findByText('/skill-creator')
    expect(screen.queryByRole('button', { name: '卸载' })).toBeNull()
    expect(writes).toEqual([])
  })
})
