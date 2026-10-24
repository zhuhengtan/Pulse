import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createLocalHost, H5Server } from '../../packages/server/src/index.js'
import { loadPulseConfig } from '../../packages/cli/src/config.js'

// Explicitly opt in. Real provider + real H5 routes, confined to a temporary workspace.
it.runIf(process.env.PULSE_CHAT_REDESIGN_LIVE === '1')('preserves a pending approval through immediate input, accepts the decision and stops a real run', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pulse-chat-interaction-live-'))
  const config = (await loadPulseConfig(root)).value
  const selected = Object.entries(config.providers ?? {}).find(([, profile]) => profile.provider === 'deepseek')
  if (!selected) throw new Error('LIVE_PROVIDER_NOT_CONFIGURED')
  const [providerId, profile] = selected, model = Object.values(profile.models ?? {})[0]?.modelCode
  const apiKey = process.env[profile.apiKeyEnv ?? 'DEEPSEEK_API_KEY']
  if (!model || !apiKey) throw new Error('LIVE_PROVIDER_CREDENTIAL_UNAVAILABLE')
  const provider = { provider: profile.provider, baseURL: profile.baseURL, apiKey, defaultModel: model, maxOutputTokens: 2048, reasoningEffort: 'none' as const }
  const reference = `${providerId}/${model}`, dataDir = join(root, 'data')
  const host = createLocalHost({ cwd: root, dataDir, provider, providerProfiles: { [providerId]: provider }, providerModels: { [reference]: { provider: providerId, model } }, activeProviderCode: providerId, activeModel: reference, taskController: false, approvalMode: 'ask', maxRuntimeMs: 120_000, maxTurns: 8, maxModelCalls: 10, jarvis: { enabled: false }, systemPrompt: 'This is an isolated integration check in a temporary directory. Follow the user tool instructions exactly, use no network tools or shell commands.' })
  const server = new H5Server(host, { dataDir, port: 0, host: '127.0.0.1' })
  try {
    const { port } = await server.start(), base = `http://127.0.0.1:${port}`
    const auth = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base } })
    const headers = { Cookie: auth.headers.get('set-cookie')!.split(';')[0]!, Origin: base, 'Content-Type': 'application/json' }
    const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    const conversation = await host.createConversation()
    const started = await post(`/api/conversations/${conversation.id}/messages`, { requestId: 'live-chat-original', text: '这是临时目录内的集成验收。请先调用 fs.write，在当前目录创建 interaction-proof.txt，内容严格为 APPROVED。写入完成后调用 ask.input，问我“是否结束验收？”，等待我的回答。不要调用其他工具，不要自动回答问题。' })
    expect(started.status).toBe(200)
    const { runId } = await started.json() as { runId: string }
    const state = () => fetch(`${base}/api/runs/${runId}/state`, { headers }).then(r => r.json())
    let approval: any
    await vi.waitFor(async () => { approval = (await state()).interactions?.find((group: any) => group.kind === 'approval'); expect(approval).toBeTruthy() }, { timeout: 60_000, interval: 500 })
    const immediate = await post(`/api/conversations/${conversation.id}/messages`, { requestId: 'live-chat-immediate', delivery: 'immediate', text: '我只是在询问当前进度，请简短告诉我是否正在等待我的审批。保留原任务和待审批操作，不要停止、不要改任务，这句话不是审批答复。' })
    expect(immediate.status).toBe(200); expect((await immediate.json()).runId).toBe(runId)
    await vi.waitFor(async () => { expect((await host.getConversationMessages(conversation.id)).some(message => message.id.startsWith('input-response-'))).toBe(true) }, { timeout: 45_000, interval: 500 })
    expect((await state()).interactions.some((group: any) => group.groupId === approval.groupId)).toBe(true)
    const decision = await post(`/api/runs/${runId}/replies`, { conversationId: conversation.id, groupId: approval.groupId, requestId: 'live-chat-approval', answers: approval.items.map((item: any) => ({ effectId: item.effectId, value: { approved: true } })) })
    expect(decision.status).toBe(200)
    await vi.waitFor(async () => { expect(await readFile(join(root, 'interaction-proof.txt'), 'utf8')).toBe('APPROVED') }, { timeout: 45_000, interval: 500 })
    await vi.waitFor(async () => { expect((await state()).interactions?.some((group: any) => group.kind === 'ask')).toBe(true) }, { timeout: 45_000, interval: 500 })
    expect((await post(`/api/runs/${runId}/cancel`, {})).status).toBe(200)
    await vi.waitFor(async () => { expect((await state()).state).toBe('cancelled') }, { timeout: 15_000, interval: 250 })
    const evidence = { provider: providerId, model, realProvider: true, httpRoutes: true, immediatePreservedRun: true, pendingApprovalPreserved: true, manualApprovalExecutedWrite: true, explicitStopConfirmed: true, isolatedWorkspace: true, residentServicesRestarted: false }
    await mkdir('artifacts/chat-redesign-2026-10-22', { recursive: true })
    await writeFile('artifacts/chat-redesign-2026-10-22/real-provider.json', JSON.stringify(evidence, null, 2))
  } finally { await server.stop(); await host.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) }
}, 180_000)
