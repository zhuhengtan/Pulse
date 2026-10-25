import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, lstat, copyFile, chmod } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import type { ComponentManifest, SignedEnvelope } from '../packages/server/src/updates/contracts.js'
import { protocols } from '../packages/server/src/updates/contracts.js'

const { ZipFile } = createRequire(import.meta.url)('../packages/server/node_modules/yazl')
export const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
export async function updateFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pulse-update-')), dataDir = join(root, 'data')
  await mkdir(dataDir)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519'), keys = { test: publicKey.export({ type: 'spki', format: 'pem' }).toString() }
  const signed = (value: unknown): SignedEnvelope => { const payload = JSON.stringify(value); return { keyId: 'test', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') } }
  const content = new Map<string, Buffer>(), refs: any[] = []
  const server = createServer((req, res) => { const bytes = content.get(req.url!); if (!bytes) { res.writeHead(404).end(); return }; res.end(bytes) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}/`
  const add = async (version = '0.9.0', component: 'backend' | 'frontend' = 'frontend', values: Record<string, string | Buffer> = { 'index.html': '<head></head><script src="./assets/main.js"></script>', 'assets/main.js': 'export const version = 1' }, patch: Partial<ComponentManifest> = {}) => {
    const archive = new ZipFile(), chunks: Buffer[] = [], files: ComponentManifest['files'] = {}
    const zipped = new Promise<Buffer>((resolve, reject) => { archive.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk)); archive.outputStream.on('end', () => resolve(Buffer.concat(chunks))); archive.outputStream.on('error', reject) })
    for (const [name, bytes] of Object.entries(values)) { const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes); files[name] = { bytes: data.length, sha256: hash(data), mode: 0o755 }; archive.addBuffer(data, name, { mode: 0o100755 }) }
    archive.end(); const bytes = await zipped, name = `${component}-${version}.zip`; content.set('/' + name, bytes)
    const manifest: ComponentManifest = { schema: 1, component, version, platform: component === 'frontend' ? 'any' : process.platform, arch: component === 'frontend' ? 'any' : process.arch, notes: '', requires: { ...protocols, ...(component === 'frontend' ? { backend: '0.8.0' } : {}) }, data: { min: 1, max: 1, writes: 1, reversible: true }, artifact: { url: base + name, bytes: bytes.length, sha256: hash(bytes) }, files, ...patch }
    const envelope = Buffer.from(JSON.stringify(signed(manifest))), url = base + name + '.json'; content.set('/' + name + '.json', envelope)
    refs.push({ component, version, platform: manifest.platform, arch: manifest.arch, url, sha256: hash(envelope) })
    return manifest
  }
  const index = (sequence = 1, expiresAt = new Date(Date.now() + 3600000).toISOString()) => content.set('/index.json', Buffer.from(JSON.stringify(signed({ schema: 1, sequence, expiresAt, releases: refs }))))
  return { root, dataDir, server, base, content, refs, keys, signed, add, index,
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections() }) }
}
export async function serviceRuntime(directory: string, version: string, fail = false): Promise<Record<string, Buffer | string>> {
  const source = `import {createServer} from 'node:http';import{readFileSync,writeFileSync}from'node:fs';import{join}from'node:path';
const data=process.env.PULSE_DATA_DIR;const args=process.argv;const at=args.indexOf('--port');const port=at<0?0:Number(args[at+1]);
${fail ? 'process.exit(42);' : ''}
const server=createServer((req,res)=>{if(req.url==='/ready'){res.end('ready');process.send({type:'update-ready'});}else if(req.url==='/stop'){res.end('stopping');server.close(()=>process.exit(0));}else res.end(JSON.stringify({version:'${version}',pid:process.pid}));});
server.listen(port,'127.0.0.1',()=>{const port=server.address().port;writeFileSync(join(data,'service.json'),JSON.stringify({pid:process.pid,port}));process.send({type:'update-health',pid:process.pid,dataDir:data,port,version:'${version}'});});
process.on('message',()=>{});process.on('disconnect',()=>server.close(()=>process.exit(0)));process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`
  const values: Record<string, string | Buffer> = { [process.platform === 'win32' ? 'node.exe' : 'node']: await readFile(process.execPath), 'desktop-runtime.json': JSON.stringify({ buildId: 'a'.repeat(64) }), 'app/node_modules/@hunterzhu/pulse-cli/package.json': JSON.stringify({ version, type: 'module' }), 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js': source, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/coordinator.js': '', 'app/node_modules/@hunterzhu/pulse-server/dist/updates/reader.js': '' }
  for (const [name, bytes] of Object.entries(values)) { const path = join(directory, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); await chmod(path, 0o755) }
  return values
}
