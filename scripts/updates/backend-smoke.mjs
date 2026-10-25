import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packComponent, signEnvelope } from './pack.mjs';
import { UpdateManager } from '../../packages/server/dist/updates/manager.js';
import { readState } from '../../packages/server/dist/updates/store.js';
import { writeRuntimeManifest } from '../../packages/desktop/src/runtime-manifest.mjs';

if (!process.env.PULSE_UPDATE_PRIVATE_KEY_FILE) throw new Error('PULSE_UPDATE_PRIVATE_KEY_FILE required');
const key = createPrivateKey(await readFile(process.env.PULSE_UPDATE_PRIVATE_KEY_FILE)), keyId = process.env.PULSE_UPDATE_KEY_ID ?? 'pulse-20261025';
const base = fileURLToPath(new URL('../../artifacts/desktop-runtime/pulse', import.meta.url));
const baseVersion = JSON.parse(await readFile(join(base, 'desktop-runtime.json'), 'utf8')).version;
const nextVersion = baseVersion.split('.').map(Number); nextVersion[2]++;
const versions = [nextVersion.join('.'), [nextVersion[0], nextVersion[1], nextVersion[2] + 1].join('.')];
const temp = await mkdtemp(join(tmpdir(), 'pulse-backend-update-')), root = join(temp, 'home'), dataDir = join(root, 'data'), content = new Map(), refs = [];
await mkdir(dataDir, { recursive: true });
const feed = createServer((request, response) => { const value = content.get(request.url); if (!value) { response.writeHead(404).end(); return; } if (Buffer.isBuffer(value)) response.end(value); else createReadStream(value).pipe(response); });
await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${feed.address().port}/`;
let logs = '';
const service = spawn(join(base, process.platform === 'win32' ? 'node.exe' : 'node'), [join(base, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'), 'h5', 'start', '--port', '0', '--data-dir', dataDir, '--mock-response', 'update-acceptance', '--no-jarvis'], { env: { ...process.env, PULSE_HOME: root, PULSE_DATA_DIR: dataDir, PULSE_CONFIG: join(root, 'config.json'), PULSE_MANAGED: '1', PULSE_RUNTIME_DIR: base }, stdio: ['ignore', 'pipe', 'pipe'] });
// The CLI prints temporary pairing URLs to stdout. Never copy them into reports.
service.stdout.resume(); service.stderr.on('data', chunk => { logs = (logs + chunk).slice(-20000); });
const stopped = new Promise(resolve => service.once('exit', resolve));
async function until(work, predicate, timeout = 120000) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { try { const value = await work(); if (predicate(value)) return value; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); } throw new Error('BACKEND_UPDATE_ACCEPTANCE_TIMEOUT'); }
try {
  const descriptor = await until(() => readFile(join(dataDir, 'service.json'), 'utf8').then(JSON.parse), item => item.managed && item.port > 0);
  const origin = `http://127.0.0.1:${descriptor.port}`;
  const bootstrap = await fetch(origin + '/api/session/local', { method: 'POST', headers: { Origin: origin } });
  const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
  const request = async (path, method = 'GET', body) => { const response = await fetch(origin + path, { method, headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); if (!response.ok) throw new Error('HTTP_' + response.status); return response.json(); };
  const device = await request('/api/session');
  let writerPid = JSON.parse(await readFile(join(dataDir, '.writer.lock'), 'utf8')).pid;
  const project = await request('/api/projects', 'POST', { name: 'Backend update acceptance', cwd: temp });
  const conversation = await request('/api/conversations', 'POST', { title: 'Preserve across backend update', projectId: project.id });
  await writeFile(join(dataDir, 'update-sentinel.txt'), 'preserve user files');
  const manager = new UpdateManager({ root, dataDir, backendVersion: baseVersion, development: true, indexUrl: baseUrl + 'index.json' });
  const results = [];
  for (const [at, version] of versions.entries()) {
    const candidate = join(temp, 'candidate-' + version), destination = join(temp, 'payload-' + version);
    await cp(base, candidate, { recursive: true, dereference: false, verbatimSymlinks: true });
    for (const name of ['data', 'runtime', 'tool-sdk', 'adapters', 'server', 'cli']) { const path = join(candidate, `app/node_modules/@hunterzhu/pulse-${name}/package.json`); const value = JSON.parse(await readFile(path)); value.version = version; await writeFile(path, JSON.stringify(value)); }
    if (at === 1) { const entry = join(candidate, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js'); await writeFile(entry, "throw new Error('ACCEPTANCE_STARTUP_FAILURE');\n" + (await readFile(entry, 'utf8')).replace(/^#![^\n]*\n/, '')); }
    const manifest = JSON.parse(await readFile(join(base, 'desktop-runtime.json'), 'utf8'));
    await writeRuntimeManifest(candidate, version, process.platform, process.arch, manifest.browserExecutable ? { browserExecutable: manifest.browserExecutable } : {});
    const ref = await packComponent({ component: 'backend', source: candidate, destination, version, platform: process.platform, arch: process.arch, baseUrl, keyId, privateKey: key });
    for (const name of await readdir(destination)) content.set('/' + name, join(destination, name));
    refs.push(ref); content.set('/index.json', Buffer.from(JSON.stringify(signEnvelope({ schema: 1, sequence: refs.length, expiresAt: new Date(Date.now() + 3600000).toISOString(), releases: refs }, key, keyId))));
    await manager.check(); await manager.download(); await manager.requestApply();
    await until(() => readState(root, dataDir), state => at === 0 ? state.active.backend?.manifest.version === version : state.failed.length > 0 && !state.pending);
    const after = await until(() => request('/api/session'), value => value.serverVersion === versions[0] && !value.maintenance);
    assert.equal(after.deviceId, device.deviceId); assert.equal((await request('/api/conversations/' + conversation.id)).title, 'Preserve across backend update');
    assert.equal(await readFile(join(dataDir, 'update-sentinel.txt'), 'utf8'), 'preserve user files');
    assert.equal(JSON.parse(await readFile(join(dataDir, 'service.json'), 'utf8')).port, descriptor.port);
    const nextWriterPid = JSON.parse(await readFile(join(dataDir, '.writer.lock'), 'utf8')).pid; assert.notEqual(nextWriterPid, writerPid); writerPid = nextWriterPid;
    results.push({ attempted: version, running: after.serverVersion, rolledBack: at === 1 });
    await rm(candidate, { recursive: true, force: true });
  }
  const report = { ok: true, shellClosed: true, realBundledNodeAndServer: true, writerRestarted: true, samePort: true, deviceAuthorizationPreserved: true, conversationPreserved: true, results };
  const artifacts = fileURLToPath(new URL('../../artifacts/update-acceptance/', import.meta.url)); await mkdir(artifacts, { recursive: true }); await writeFile(join(artifacts, 'backend.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} catch (error) { process.stderr.write(logs); throw error; }
finally { service.kill('SIGTERM'); const timer = setTimeout(() => service.kill('SIGKILL'), 25000); await stopped; clearTimeout(timer); feed.closeAllConnections(); await new Promise(resolve => feed.close(resolve)); await rm(temp, { recursive: true, force: true }); }
