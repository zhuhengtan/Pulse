'use strict'
const { parentPort, workerData } = require('node:worker_threads')

// Trusted installed modules only. No model/workspace configuration chooses these
// URLs; they are fixed by the adapter (or an explicit local test fixture).
for (const value of [workerData.manager, workerData.initialization]) {
  if (typeof value !== 'string' || new URL(value).protocol !== 'file:') throw new Error('INVALID_SANDBOX_WORKER_MODULE')
}
const modules = Promise.all([import(workerData.manager), import(workerData.initialization)])
let tail = Promise.resolve()
const controllers = new Map()
const errorData = error => {
  const output = { name: String(error?.name ?? 'Error'), message: String(error?.message ?? 'SANDBOX_WORKER_OPERATION_FAILED').slice(0, 4000) }
  for (const key of ['code', 'subcommand', 'syscall', 'address', 'port']) if (typeof error?.[key] === 'string' || typeof error?.[key] === 'number') output[key] = error[key]
  return output
}
parentPort.on('message', request => {
  if (typeof request?.abort === 'string') { controllers.get(request.abort)?.abort(); return }
  if (!request || typeof request.id !== 'string' || !Array.isArray(request.args) || !(request.cancellation instanceof SharedArrayBuffer)) throw new Error('INVALID_SANDBOX_WORKER_REQUEST')
  const controller = new AbortController(), flag = new Int32Array(request.cancellation)
  controllers.set(request.id, controller)
  const check = () => {
    if (Atomics.load(flag, 0)) { controller.abort(); throw Object.assign(new Error('The sandbox preparation was cancelled'), { name: 'AbortError', code: 'ABORT_ERR' }) }
    controller.signal.throwIfAborted()
  }
  const execute = async () => {
    try {
      const [sdk, helper] = await modules
      const manager = sdk.SandboxManager ?? sdk.default?.SandboxManager
      let value
      if (request.operation === 'reset') value = await manager.reset()
      else if (request.operation === 'cleanup') value = await manager.cleanupAfterCommand()
      else if (request.operation === 'annotate') value = manager.annotateStderrWithSandboxFailures(...request.args)
      else if (request.operation === 'initialize') {
        check()
        value = await helper.initializeShellSandbox(request.args[0], 'win32', controller.signal, check)
        check()
      } else if (request.operation === 'wrap') {
        check()
        value = await manager.wrapWithSandboxArgv(request.args[0], undefined, undefined, controller.signal, request.args[1], request.args[2])
        check()
      } else throw new Error('INVALID_SANDBOX_WORKER_OPERATION')
      parentPort.postMessage({ id: request.id, ok: true, value })
    } catch (error) { parentPort.postMessage({ id: request.id, ok: false, error: errorData(error) }) }
    finally { controllers.delete(request.id) }
  }
  tail = tail.then(execute, execute)
})
