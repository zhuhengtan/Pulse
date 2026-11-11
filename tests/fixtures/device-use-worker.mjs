import { randomUUID } from 'node:crypto'
let configuration, start, sequence = 0, action = 'device.list'
const send = value => process.send?.(value)
const context = { toolCallId: 'fixture-call', effectId: 'fixture-effect', attemptId: 'fixture-attempt', agentId: 'fixture-agent', laneId: 'fixture-lane' }
function call(name, input) {
  action = name
  send({ schemaVersion: 1, type: 'deviceUseRequest', sessionId: start.text === 'wrong-session' ? randomUUID() : configuration.sessionId, runId: start.runId ?? 'run-device-fixture', requestId: randomUUID(), name, input, context })
}
function finish(result) {
  send({ schemaVersion: 1, type: 'event', event: { schemaVersion: 1, type: 'text', runId: start.runId ?? 'run-device-fixture', conversationId: start.conversationId, seq: ++sequence, data: JSON.stringify(result) } })
  send({ schemaVersion: 1, type: 'event', event: { schemaVersion: 1, type: 'complete', runId: start.runId ?? 'run-device-fixture', conversationId: start.conversationId, seq: ++sequence, data: { status: 'succeeded' } } })
  process.send?.({ schemaVersion: 1, type: 'settled', outcome: { status: 'succeeded' }, usage: { schemaVersion: 1, modelCalls: 0 } }, () => process.disconnect())
}
process.on('message', message => {
  if (message.type === 'shutdown') { process.disconnect(); return }
  if (message.type === 'rpc') { send({ schemaVersion: 1, type: 'rpcResult', requestId: message.requestId, ok: true }); return }
  if (message.type === 'configure') { configuration = message.deviceUse; send({ schemaVersion: 1, type: 'configured' }); return }
  if (message.type === 'start') {
    start = message
    send({ schemaVersion: 1, type: 'started', requestId: start.requestId, runId: start.runId ?? 'run-device-fixture', conversationId: start.conversationId })
    if (!configuration || !configuration.tools.length) { finish({ disabled: true }); return }
    setTimeout(() => call(start.text === 'invalid-input' ? 'device.read' : 'device.list', start.text === 'invalid-input' ? { deviceId: 'sim:light', principal: 'admin' } : {}), 1)
    return
  }
  if (message.type === 'deviceUseResult') {
    if (!message.ok || start.text !== 'control' || action === 'device.set') { finish(message); return }
    const grant = message.value.grants.find(grant => grant.deviceId === 'sim:light')
    call('device.set', { requestId: 'worker-fixture-control', deviceId: 'sim:light', desiredState: { power: true, brightness: 30 }, authorizationRef: grant.authorizationRef, deadline: Date.now() + 3_000 })
  }
})
send({ schemaVersion: 1, type: 'ready' })
