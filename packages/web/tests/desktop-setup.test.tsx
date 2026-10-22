import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { DesktopEnvironment, type DesktopSetupStatus } from '../src/DesktopSetup.js'
import { PulseDesignSystem } from '../src/PulseDesignSystem.js'
import type { PulseWebTransport } from '../src/transport.js'
beforeAll(() => {
 Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true })
 const style = window.getComputedStyle.bind(window); window.getComputedStyle = element => style(element)
})
afterEach(cleanup)
const ready: DesktopSetupStatus = { phase: 'ready', firstRun: true, version: '0.7.0', cli: { path: '/example/.pulse/bin/pulse' }, service: { connected: true }, steps: [{ id: 'runtime', label: '准备 Pulse 运行环境', state: 'ready', detail: '内置 Node、CLI 和 Server' }, { id: 'server', label: '启动本机后台', state: 'ready' }] }
function fixture(value = ready) {
 let status = structuredClone(value)
 const calls: string[] = []
 const transport: PulseWebTransport = { request: async (path, init) => { if (init?.method === 'POST') { calls.push(path); if (path.endsWith('/complete')) status = { ...status, firstRun: false }; if (path.endsWith('/repair')) status = ready } return Response.json(status) }, subscribe: () => () => {} }
 return { transport, calls }
}
it('offers model configuration after preparation and persists completion before navigation', async () => {
 const f = fixture(), next = vi.fn()
 render(<PulseDesignSystem><DesktopEnvironment transport={f.transport} welcome onConfigureModels={next} /></PulseDesignSystem>)
 await screen.findByText('运行环境已准备完成。')
 expect(screen.getByText(/pulse --version/)).toBeTruthy()
 fireEvent.click(screen.getByRole('button', { name: '配置模型', exact: true }))
 await waitFor(() => expect(next).toHaveBeenCalledOnce())
 expect(f.calls).toEqual(['/api/desktop/setup/complete'])
})
it('shows preparation failures and supports repair without stopping the background', async () => {
 const f = fixture({ ...ready, phase: 'error', error: '运行环境准备失败，请点击修复重试。' })
 render(<PulseDesignSystem><DesktopEnvironment transport={f.transport} welcome /></PulseDesignSystem>)
 await screen.findByRole('alert')
 fireEvent.click(screen.getByRole('button', { name: '检查并修复', exact: true }))
 await screen.findByText('运行环境已准备完成。')
 expect(f.calls).toEqual(['/api/desktop/setup/repair'])
})
it('explains independent CLI conflicts and provides the full desktop command path', async () => {
 const f = fixture({ ...ready, cli: { path: '/example/.pulse/bin/pulse', conflict: '/existing/pulse' } })
 render(<PulseDesignSystem><DesktopEnvironment transport={f.transport}/></PulseDesignSystem>)
 expect(await screen.findByText(/已有其他 pulse 命令/)).toBeTruthy()
 expect(screen.getByText('/example/.pulse/bin/pulse')).toBeTruthy()
 expect(f.calls).toEqual([])
})
it('keeps navigation disabled until the background is ready and updates in place', async () => {
 const f = fixture({ ...ready, phase: 'starting' })
 render(<PulseDesignSystem><DesktopEnvironment transport={f.transport} welcome /></PulseDesignSystem>)
 await screen.findByText('正在准备运行环境，首次启动可能需要一点时间。')
 expect(screen.queryByRole('button', { name: '配置模型', exact: true })).toBeNull()
 expect(screen.getByRole('button', { name: '检查并修复', exact: true }).hasAttribute('disabled')).toBe(true)
})
