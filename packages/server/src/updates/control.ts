import { createRequire } from 'node:module'
import { UpdateManager } from './manager.js'

/** Shell recovery entry: all update logic still lives in the backend package. */
async function main(): Promise<void> {
  const [root, dataDir, shellVersion, chromium, path, method = 'GET', body = '{}'] = process.argv.slice(2)
  if (!root || !dataDir || !shellVersion || !path) throw new Error('UPDATE_CONTROL_ARGUMENTS_INVALID')
  const manager = new UpdateManager({ root, dataDir, backendVersion: (createRequire(import.meta.url)('../../package.json') as { version: string }).version, shellVersion, chromium: Number(chromium), development: process.env.PULSE_MANAGED !== '1' })
  if (path === '/api/updates' && method === 'GET') { /* A status read also works while the service is stopped. */ }
  else if (method === 'POST') {
    const action = path.slice('/api/updates/'.length)
    if (action === 'check') await manager.check()
    else if (action === 'download') await manager.download(true)
    else if (action === 'apply' || action === 'rollback') await manager.requestApply(action === 'rollback')
    else if (action === 'settings') { const settings = JSON.parse(body) as { autoDownload?: unknown }; if (typeof settings.autoDownload !== 'boolean') throw new Error('UPDATE_SETTINGS_INVALID'); await manager.settings(settings.autoDownload) }
    else throw new Error('UPDATE_CONTROL_PATH_INVALID')
  } else throw new Error('UPDATE_CONTROL_PATH_INVALID')
  process.stdout.write(JSON.stringify({ status: 200, body: { ...await manager.status(), serviceOffline: true } }))
}
await main().catch(error => { process.stdout.write(JSON.stringify({ status: 409, body: { error: error instanceof Error ? error.message : 'UPDATE_FAILED' } })) })
