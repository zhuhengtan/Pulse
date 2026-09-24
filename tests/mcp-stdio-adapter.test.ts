import { afterEach, describe, expect, it } from 'vitest'
import { McpStdioClient, createMcpStdioAdapter } from '../packages/adapters/src/mcp/stdio.js'

const clients: McpStdioClient[] = []

function fixture(mode = 'normal'): { command: string; args: string[] } {
  const source = String.raw`
const readline = require('node:readline');
const mode = process.argv[1];
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
rl.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } });
  } else if (message.method === 'tools/list') {
    if (mode === 'loop') send({ jsonrpc: '2.0', id: message.id, result: { tools: [], nextCursor: String(Number(message.params.cursor || 0) + 1) } });
    else if (!message.params.cursor) send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo input', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }], nextCursor: 'second' } });
    else send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'count', inputSchema: { type: 'object' } }] } });
  } else if (message.method === 'tools/call' && mode !== 'hang') {
    const text = mode === 'env' ? (process.env.PULSE_TEST_SECRET || 'absent') : mode === 'env-path' ? JSON.stringify({ secret: process.env.PULSE_TEST_SECRET, path: Boolean(process.env.PATH) }) : (message.params.arguments.text || 'ok');
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }], isError: false } });
  } else if (message.method === 'exit-now') {
    process.exit(9);
  }
});
`
  return { command: process.execPath, args: ['-e', source, mode] }
}

afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())) })

describe('MCP stdio adapter', () => {
  it('performs the lifecycle, maps paginated tool schemas, and calls remote tools', async () => {
    const { client, tools } = await createMcpStdioAdapter({ ...fixture(), namespace: 'demo', timeoutMs: 2_000 })
    clients.push(client)

    expect(tools.map((tool) => tool.manifest.name)).toEqual(['demo.echo', 'demo.count'])
    expect(tools[0]?.manifest.inputSchema).toEqual({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false })
    expect(() => tools[0]?.validateInput?.({ text: 42 })).toThrow('MCP_INVALID_TOOL_INPUT:echo')
    expect(await client.callTool('echo', { text: 'hello' })).toEqual({ content: [{ type: 'text', text: 'hello' }], isError: false })
  })

  it('rejects a tool call that exceeds its timeout and closes the child', async () => {
    const client = new McpStdioClient({ ...fixture('hang'), timeoutMs: 100, shutdownTimeoutMs: 100 })
    clients.push(client)
    await client.connect()

    await expect(client.callTool('echo', { text: 'slow' }, { timeoutMs: 50 })).rejects.toThrow('MCP_REQUEST_TIMEOUT:tools/call:50')
    await client.close()
    await expect(client.callTool('echo', { text: 'again' })).rejects.toThrow('MCP_CLIENT_NOT_CONNECTED')
  })

  it('rejects outstanding requests when the server exits unexpectedly', async () => {
    const source = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + '\n'); }
rl.on('line', (line) => { const m = JSON.parse(line); if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'exit', version: '1' } } }); else if (m.method === 'tools/list') setTimeout(() => process.exit(7), 10); });
`
    const client = new McpStdioClient({ command: process.execPath, args: ['-e', source], timeoutMs: 1_000 })
    clients.push(client)

    await expect(client.connect()).rejects.toThrow('MCP_SERVER_EXITED:7')
  })

  it('rejects a call when its AbortSignal is cancelled', async () => {
    const client = new McpStdioClient({ ...fixture('hang'), timeoutMs: 1_000 })
    clients.push(client)
    await client.connect()
    const controller = new AbortController()
    const pending = client.callTool('echo', { text: 'cancel' }, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toThrow('MCP_TOOL_CALL_ABORTED')
  })

  it('does not inherit credential-like host environment variables by default', async () => {
    const previous = process.env.PULSE_TEST_SECRET
    process.env.PULSE_TEST_SECRET = 'sentinel-value'
    try {
      const client = new McpStdioClient({ ...fixture('env'), timeoutMs: 1_000 })
      clients.push(client)
      await client.connect()
      await expect(client.callTool('echo', { text: 'ignored' })).resolves.toMatchObject({ content: [{ text: 'absent' }] })
    } finally {
      if (previous === undefined) delete process.env.PULSE_TEST_SECRET
      else process.env.PULSE_TEST_SECRET = previous
    }
  })

  it('merges explicit environment values with the safe default environment', async () => {
    const client = new McpStdioClient({ ...fixture('env-path'), env: { PULSE_TEST_SECRET: 'configured' }, timeoutMs: 1_000 })
    clients.push(client)
    await client.connect()
    await expect(client.callTool('echo', { text: 'ignored' })).resolves.toMatchObject({ content: [{ text: JSON.stringify({ secret: 'configured', path: true }) }] })
  })

  it('stops hostile tools/list pagination at the configured page limit', async () => {
    const client = new McpStdioClient({ ...fixture('loop'), maxToolPages: 3, timeoutMs: 2_000 })
    clients.push(client)
    await expect(client.connect()).rejects.toThrow('MCP_PROTOCOL_ERROR:tools/list exceeded 3 pages')
  })

})
