import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { selectedFrontend, verifySelectedFile } from '../packages/desktop/src/update-loader.mjs'

const protocols = { http: 1, events: 1, bridge: 1, nativeBrowser: 1, reader: 1 }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

async function installFrontend(requires: Record<string, string | number> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pulse-loader-')), dataDir = join(root, 'data')
  await mkdir(dataDir)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const keys = { test: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const bodies = { 'index.html': '<head></head>', 'assets/main.js': 'export const version = 1' }
  const files = Object.fromEntries(Object.entries(bodies).map(([name, text]) => [name, { bytes: Buffer.byteLength(text), sha256: digest(text), mode: 0o644 }]))
  const manifest = { schema: 1, component: 'frontend', version: '0.9.0', platform: 'any', arch: 'any', notes: '', requires: { ...protocols, backend: '0.8.0', ...requires }, data: { min: 1, max: 1, writes: 1, reversible: true }, artifact: { url: 'https://example.com/frontend.zip', bytes: 1, sha256: 'ab'.repeat(32) }, files }
  const payload = JSON.stringify(manifest)
  const envelope = { keyId: 'test', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') }
  const { files: _files, ...metadata } = manifest
  const id = `frontend-0.9.0-${manifest.artifact.sha256.slice(0, 16)}`
  const directory = join(root, 'updates/components', id)
  await mkdir(join(directory, 'assets'), { recursive: true })
  for (const [name, text] of Object.entries(bodies)) await writeFile(join(directory, name), text)
  await writeFile(join(directory, 'component.json'), JSON.stringify(envelope))
  const scope = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 32)
  await mkdir(join(root, 'updates/scopes'), { recursive: true })
  await writeFile(join(root, 'updates/scopes', `${scope}.json`), JSON.stringify({ schema: 1, active: { frontend: { directory, manifest: metadata } }, failed: [], available: [] }))
  return { root, dataDir, keys, directory }
}

it('rejects a signed frontend when a non-critical asset changes', async () => {
  const installed = await installFrontend()
  try {
    await writeFile(join(installed.directory, 'assets/main.js'), 'tampered')
    await expect(selectedFrontend(installed.root, installed.dataDir, '0.8.0', 130, undefined, installed.keys)).rejects.toThrow('RUNTIME_FILE_CHANGED:assets/main.js')
  } finally { await rm(installed.root, { recursive: true, force: true }) }
})

it('checks the file being served again after the component was accepted', async () => {
  const installed = await installFrontend()
  try {
    const selected = await selectedFrontend(installed.root, installed.dataDir, '0.8.0', 130, undefined, installed.keys)
    expect(selected?.version).toBe('0.9.0')
    await writeFile(join(installed.directory, 'assets/main.js'), 'tampered')
    await expect(verifySelectedFile(selected!.directory, selected!.files, 'assets/main.js')).rejects.toThrow('RUNTIME_FILE_CHANGED:assets/main.js')
  } finally { await rm(installed.root, { recursive: true, force: true }) }
})

it('rejects a frontend whose shell requirement is missing or too new', async () => {
  const installed = await installFrontend({ shell: '9.0.0' })
  try {
    await expect(selectedFrontend(installed.root, installed.dataDir, '0.8.0', 130, undefined, installed.keys)).rejects.toThrow('UPDATE_SHELL_REQUIRED')
    await expect(selectedFrontend(installed.root, installed.dataDir, undefined, 130, undefined, installed.keys)).rejects.toThrow('UPDATE_SHELL_REQUIRED')
  } finally { await rm(installed.root, { recursive: true, force: true }) }
})
