import type { LocalHost } from '../../packages/server/src/index.js'

/** Transport and execution fixtures supply an execution decision without a model. */
export function acceptWorkRequests(host: LocalHost, operation: 'start' | 'continue' = 'start'): void {
  host.sendWorkTurn = (conversationId, input, execute = value => host.sendMessage(conversationId, value)) =>
    execute({ ...input, workOperation: operation, continueTask: operation === 'continue' })
}
