import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, createPrivateKey } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLocalHost, H5Server } from '../../packages/server/dist/index.js';
import { packComponent, signEnvelope } from './pack.mjs';
import { releaseId } from '../../packages/server/dist/updates/contracts.js';

if (!process.env.PULSE_UPDATE_PRIVATE_KEY_FILE) throw new Error('PULSE_UPDATE_PRIVATE_KEY_FILE is required for real shell trust verification');
const key = createPrivateKey(await readFile(process.env.PULSE_UPDATE_PRIVATE_KEY_FILE)), keyId = process.env.PULSE_UPDATE_KEY_ID ?? 'pulse-20261025';
const temporary = await mkdtemp(join(tmpdir(), 'pulse-update-frontend-')), root = join(temporary, 'home'), dataDir = join(temporary, 'data');
const content = new Map(), refs = [];
const feed = createServer((request, response) => { const bytes = content.get(request.url); if (!bytes) { response.writeHead(404).end(); return; } response.end(bytes); });
await new Promise(resolve => feed.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${feed.address().port}/`;
const host = createLocalHost({ cwd: temporary, dataDir, provider: { provider: 'mock', defaultModel: 'mock' }, jarvis: { enabled: false } });
const server = new H5Server(host, { dataDir, port: 0, host: '127.0.0.1', updates: { root, development: true, indexUrl: baseUrl + 'index.json' } });
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { _electron } = createRequire(require.resolve('@playwright/mcp'))('playwright');
const electron = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
let desktop;
try {
  await host.init(); await server.start(); server.updates.stop();
  const env = { ...process.env, PULSE_HOME: root, PULSE_DESKTOP_INSTALL_ROOT: root, PULSE_DESKTOP_USER_DATA: join(temporary, 'user-data'), PULSE_DESKTOP_DATA_DIR: dataDir };
  delete env.ELECTRON_RUN_AS_NODE; delete env.PULSE_DESKTOP_RUNTIME_DIR; delete env.PULSE_DESKTOP_DEV_URL;
  desktop = await _electron.launch({ executablePath: process.env.PULSE_DESKTOP_EXECUTABLE ?? electron, args: process.env.PULSE_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env });
  const page = await desktop.firstWindow();
  const setupDeadline = Date.now() + 190000; let completed = false, lastPhase;
  while (!completed && Date.now() < setupDeadline) {
    const state = await page.evaluate(async () => (await window.pulseDesktop.request('/api/desktop/setup')).body);
    if (state.phase !== lastPhase) { console.log('[frontend:update] setup ' + state.phase); lastPhase = state.phase; }
    if (state.phase === 'error') throw new Error('UPDATE_ACCEPTANCE_SETUP_FAILED');
    if (state.phase === 'ready') { try { await page.evaluate(async () => window.pulseDesktop.request('/api/desktop/setup/complete', { method: 'POST' })); completed = true; } catch {} }
    if (!completed) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(completed, true, 'Setup must settle before testing frontend reloads');
  await page.reload();
  await page.locator('[contenteditable=true]').waitFor();
  const draft = '热更新验收：刷新后保留这条草稿';
  await page.locator('[contenteditable=true]').fill(draft);
  const generations = [];
  for (const version of ['0.8.1', '0.8.2']) {
    const destination = join(temporary, version); await mkdir(destination);
    const ref = await packComponent({ component: 'frontend', source: fileURLToPath(new URL('../../packages/web/dist', import.meta.url)), destination, version, baseUrl, keyId, privateKey: key });
    for (const name of await readdir(destination)) content.set('/' + name, await readFile(join(destination, name)));
    refs.push(ref); content.set('/index.json', Buffer.from(JSON.stringify(signEnvelope({ schema: 1, sequence: refs.length, expiresAt: new Date(Date.now() + 3600000).toISOString(), releases: refs }, key, keyId))));
    await server.updates.check(); await server.updates.download(); await server.updates.requestApply(); assert.equal(await server.updates.applyFrontend(), true);
    const status = await server.updates.status(); assert.equal(status.frontendVersion, version); generations.push(status.frontend);
    await page.getByRole('button', { name: '保留草稿并刷新' }).click({ timeout: 15000 });
    await page.waitForFunction(value => document.querySelector('meta[name="pulse-frontend"]')?.content === value, status.frontend);
    await page.waitForFunction(value => document.querySelector('[contenteditable=true]')?.textContent === value, draft);
  }
  const script = await page.locator('script[type=module]').first().getAttribute('src');
  const previousScript = script.replace(generations[1], generations[0]);
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, previousScript), 200);
  await server.stop();
  const offlineUpdates = await page.evaluate(async () => window.pulseDesktop.request('/api/updates'));
  assert.equal(offlineUpdates.status, 200); assert.equal(offlineUpdates.body.serviceOffline, true); assert.equal(offlineUpdates.body.frontend, generations[1]);
  const artifacts = fileURLToPath(new URL('../../artifacts/update-acceptance/', import.meta.url)); await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: join(artifacts, 'frontend-updated.png') });
  const report = { ok: true, packaged: Boolean(process.env.PULSE_DESKTOP_EXECUTABLE), signedFrontend: true, electronShellUnchanged: true, generations, draftSurvivesTwoReloads: true, oldAssetsRetained: true, updateStatusWithoutServer: true };
  await writeFile(join(artifacts, 'frontend.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
} finally {
  if (desktop) await desktop.close(); await server.stop(); await host.close(); await new Promise(resolve => feed.close(resolve)); feed.closeAllConnections(); await rm(temporary, { recursive: true, force: true });
}
