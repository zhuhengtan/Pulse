import type { PulseWebTransport } from '../../src/transport.js'

/** Safe sample configuration. No real credentials, processes, or configuration writes. */
export function settingsFixture() {
  const config = {
    providers: {
      sample: { name: '示例服务商', provider: 'openai-compatible', baseURL: 'https://example.com/v1', apiKeyEnv: 'SAMPLE_API_KEY', models: { chat: { displayName: '示例模型', modelCode: 'sample-chat', maxContextTokens: 256000, maxOutputTokens: 16384, pricing: { inputPerMillion: 0.25, outputPerMillion: 1, currency: 'USD' } } } },
      local: { name: '本机模型', provider: 'ollama', baseURL: 'http://127.0.0.1:11434', models: { review: { displayName: '复核模型', modelCode: 'sample-review' } } },
    },
    activeModel: 'sample/chat', assistantModel: 'sample/chat',
    taskRouting: Object.fromEntries(['reason', 'plan', 'merge', 'verify', 'vision'].map(task => [task, ['sample/chat', 'local/review']])),
    frontModel: { enabled: true, model: 'local/review', timeoutMs: 15000 },
    approvalMode: 'ask', approvalReview: { model: 'local/review', timeoutMs: 15000 },
    jarvis: { enabled: true, token: '__PULSE_KEEP_SECRET__', apiUrl: 'http://127.0.0.1:7330', contextTokenBudget: 4000, autoCandidate: true },
    capabilities: { enabled: ['pdf', 'spreadsheet', 'browser', 'computer', 'skills'], skills: ['example-skill'], trustedSkillRoots: ['/example/skills'],
      browser: { mode: 'existing', channel: 'chrome' }, computer: { helperPath: '/example/Pulse Desktop Helper.app' },
      mcpServers: { 'sample-service': { command: 'sample-command', cwd: '/example/workspace', args: ['--example', 'sample'], timeoutMs: 30000, env: { SAMPLE_TOKEN: '__PULSE_KEEP_SECRET__' }, envFrom: { SAMPLE_ENDPOINT: 'SAMPLE_ENDPOINT' }, toolPolicies: { 'sample.read': 'read', 'sample.write': 'write' } } } },
    allowNetwork: true, networkHosts: ['example.com', 'localhost'], systemPrompt: '这是用于界面检查的测试指令。', systemPromptFile: '/example/instructions.txt',
    cwd: '/example/Pulse', dataDir: '/example/data', maxTurns: 32, maxRuntimeMs: 900000, autoCompactPercent: 90,
  }
  const writes: Array<{ path: string; method: string }> = []
  const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
  const transport: PulseWebTransport = {
    async request(path, init) {
      const method = init?.method ?? 'GET'
      if (method !== 'GET') writes.push({ path, method })
      if (path === '/api/config') return response({ path: '/example/config.json', config, version: 'fixture', sources: {}, environment: { SAMPLE_API_KEY: true }, backupAvailable: true, active: { provider: 'sample', model: 'sample/chat' } })
      if (path === '/api/config/validate') return response({ valid: true, restartRequired: [] })
      if (path === '/api/automation/vision-probe') return response({ error: 'FIXTURE_PROBE_FAILURE' }, 400)
      if (path === '/api/conversations?archived=1') return response([{ id: 'audit-archived', title: '示例归档对话：检查长标题在手机上的显示效果', cwd: '/example/project-with-a-long-directory-name/workspace', createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z' }])
      if (path.endsWith('/artifacts')) return response([{ path: 'reports/example-report.txt', label: '示例报告', runId: 'fixture-run', absolutePath: '/example/project/reports/example-report.txt', workspaceState: 'project' }])
      if (path.includes('/artifacts/content?')) return response({ content: '这是用于检查交付文件预览的示例内容。\n第二行：确认换行、滚动和折叠正常。' })
      if (method === 'DELETE' || method === 'POST' || method === 'PATCH') return response({ ok: true })
      return response({ error: 'FIXTURE_ROUTE_NOT_FOUND' }, 404)
    },
    subscribe: () => () => {},
  }
  return { transport, writes, config }
}
