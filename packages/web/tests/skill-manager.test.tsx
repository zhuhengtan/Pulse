import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SkillManager } from '../src/SkillManager.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'

beforeAll(() => { Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true }) })
afterEach(cleanup)
const detail = { name: 'demo', description: '示例技能', content: '---\nname: demo\n---\nSkill body', warnings: [], files: [{ path: 'SKILL.md', bytes: 100 }, { path: 'scripts/run.mjs', bytes: 20 }], compatibility: 'Node.js', origin: { repository: 'owner/repo', directory: 'skills/demo', commit: 'a'.repeat(40), ref: 'HEAD' } }
function fixture(fail = false, initialInstalled = false, modified = false) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = []
  let installed = initialInstalled, version = detail.origin.commit, update: unknown
  const skills = () => [{ name: 'skill-creator', description: '创建技能', builtin: true }, ...(installed ? [{ name: 'demo', description: '示例技能', managed: true, modified, version, origin: { ...detail.origin, commit: version }, update }] : [])]
  const transport: PulseWebTransport = {
    subscribe: () => () => {},
    request: vi.fn(async (path, init) => {
      const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
      if (path.endsWith('/installed')) return respond({ skills: skills() })
      if (path.endsWith('/check-updates')) { update = { status: fail ? 'error' : 'available', latestCommit: fail ? undefined : 'b'.repeat(40), error: fail ? 'SKILL_REMOTE_RATE_LIMITED' : undefined, checkedAt: '2026-10-25T12:00:00Z' }; return respond({ skills: skills() }) }
      if (path.endsWith('/update')) { writes.push({ path, body: JSON.parse(String(init?.body)) }); version = 'b'.repeat(40); update = { status: 'current', latestCommit: version, checkedAt: '2026-10-25T12:00:00Z' }; return respond({ name: 'demo', version }) }
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
  it('compares installed and market revisions then synchronizes the checked version', async () => {
    const { transport, writes } = fixture(false, true), changed = mount(transport)
    fireEvent.click(screen.getByRole('button', { name: '已安装', exact: true }))
    await screen.findByText('aaaaaaaaaaaa')
    fireEvent.click(screen.getByRole('button', { name: '检查技能更新' }))
    await screen.findByText('技能版本检查完成：1 个有更新。')
    expect(screen.getByText('bbbbbbbbbbbb')).toBeTruthy()
    expect(writes).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: '更新至最新版' }))
    await screen.findByText('技能已同步市场最新版。')
    expect(writes).toEqual([{ path: '/api/skill-marketplace/update', body: { name: 'demo', expectedCommit: 'b'.repeat(40), configVersion: 'version' } }])
    expect(changed).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: '更新至最新版' })).toBeNull()
    expect(screen.getByText(/内容已是最新/)).toBeTruthy()
  })
  it.each(['draft', 'modified'])('allows checks but prevents overwriting a skill with %s changes', async reason => {
    const { transport, writes } = fixture(false, true, reason === 'modified'); mount(transport, reason === 'draft')
    fireEvent.click(screen.getByRole('button', { name: '已安装', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '检查 demo 更新' }))
    const update = await screen.findByRole('button', { name: '更新至最新版' })
    expect(update.hasAttribute('disabled')).toBe(true)
    expect(writes).toEqual([])
  })
  it('keeps the installed version visible after a market check fails', async () => {
    const { transport, writes } = fixture(true, true); mount(transport)
    fireEvent.click(screen.getByRole('button', { name: '已安装', exact: true }))
    fireEvent.click(await screen.findByRole('button', { name: '检查 demo 更新' }))
    await screen.findByText('平台请求过多，请稍后重试。')
    expect(screen.getByText('aaaaaaaaaaaa')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更新至最新版' })).toBeNull()
    expect(writes).toEqual([])
  })
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
