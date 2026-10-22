import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { _electron } = createRequire(require.resolve('@playwright/mcp'))('playwright');
const execute = promisify(execFile);
const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-clean-install-')));
const install = join(root, '.pulse'), profile = join(root, 'profile'), data = join(install, 'data'), shellHome = join(root, 'shell');
const executablePath = process.env.PULSE_DESKTOP_EXECUTABLE ?? createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
const args = process.env.PULSE_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../../packages/desktop', import.meta.url))];
const env = { ...process.env, PATH: join(root, 'empty-path'), PULSE_HOME: install, PULSE_CONFIG: join(install, 'config.json'), PULSE_DESKTOP_INSTALL_ROOT: install, PULSE_DESKTOP_USER_DATA: profile, PULSE_DESKTOP_DATA_DIR: data, PULSE_DESKTOP_SHELL_HOME: shellHome, ZDOTDIR: shellHome, PULSE_DESKTOP_RUNTIME_DIR: fileURLToPath(new URL('../../artifacts/desktop-runtime/pulse', import.meta.url)), PULSE_ALLOW_NETWORK: '1', PULSE_JARVIS_ENABLED: 'false' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PULSE_DESKTOP_DEV_URL;
delete env.PULSE_BROWSER_EXECUTABLE;
let desktop, pid;
const website = createServer((_request, response) => response.end('<title>Bundled browser ready</title><h1>Bundled browser ready</h1>'));
async function launch() { desktop = await _electron.launch({ executablePath, args, env, timeout: 30000 }); return desktop.firstWindow(); }
async function status(page) { return page.evaluate(async () => (await window.pulseDesktop.request('/api/desktop/setup')).body); }
async function ready(page) {
    const deadline = Date.now() + 180000;
    let value;
    do { value = await status(page); if (['ready', 'error'].includes(value.phase)) break; await new Promise(resolve => setTimeout(resolve, 300)); } while (Date.now() < deadline);
    assert.equal(value.phase, 'ready', JSON.stringify(value)); return value;
}
async function request(page, path, body) {
    const value = await page.evaluate(async ({ path, body }) => window.pulseDesktop.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), { path, body });
    assert.ok(value.status >= 200 && value.status < 300, JSON.stringify(value.body)); return value.body;
}
try {
    await mkdir(shellHome);
    await new Promise(resolve => website.listen(0, '127.0.0.1', resolve));
    let page = await launch();
    const first = await ready(page);
    assert.equal(first.firstRun, true);
    assert.equal(first.development, false);
    await page.getByRole('heading', { name: '欢迎使用 Pulse' }).waitFor();
    await page.getByRole('button', { name: '配置模型', exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-first-install.png') });
    const config = await readFile(first.configPath, 'utf8');
    const descriptor = JSON.parse(await readFile(join(data, 'service.json'), 'utf8')); pid = descriptor.pid;
    assert.equal(first.service.pid, pid);
    const runCli = async path => process.platform === 'win32' ? execute(process.env.ComSpec, ['/d', '/s', '/c', `""${path}" --version"`], { env }) : execute(path, ['--version'], { env });
    assert.match((await runCli(first.cli.path)).stdout, /0\.7\.0/);
    if (process.platform !== 'win32') {
        const shellResult = await execute('/bin/sh', ['-c', '. "$1"; command -v pulse; pulse --version', 'fixture', join(shellHome, '.profile')], { env });
        assert.ok(shellResult.stdout.includes(first.cli.path));
    }
    await page.getByRole('button', { name: '稍后配置，进入 Pulse' }).click();
    await page.getByRole('heading', { name: '我们要做什么？' }).waitFor();
    const device = await request(page, '/api/session');
    const project = await request(page, '/api/projects', { name: 'Clean install fixture', cwd: root });
    const conversation = await request(page, '/api/conversations', { title: 'Preserve installed history', projectId: project.id });
    const browser = await request(page, '/api/automation/sessions', { kind: 'browser', manual: true, projectId: project.id });
    const control = await request(page, `/api/automation/sessions/${browser.id}/control`, { action: 'takeover' });
    await request(page, `/api/automation/sessions/${browser.id}/command`, { lease: control.lease, method: 'navigate', params: { url: `http://127.0.0.1:${website.address().port}` } });
    await request(page, `/api/automation/sessions/${browser.id}/observe`, {});
    const browsers = await request(page, '/api/automation/sessions');
    assert.ok(browsers.sessions.some(item => item.title === 'Bundled browser ready'));
    await request(page, `/api/automation/sessions/${browser.id}/control`, { action: 'close', lease: control.lease });
    const sentinel = join(data, 'install-preservation-check.txt'); await writeFile(sentinel, 'preserve user data');
    await desktop.close(); desktop = undefined;
    process.kill(pid, 0);
    page = await launch();
    const reopened = await ready(page);
    assert.equal(reopened.firstRun, false);
    assert.equal(reopened.runtimeDirectory, first.runtimeDirectory);
    assert.equal(reopened.service.pid, pid);
    assert.equal((await request(page, '/api/session')).deviceId, device.deviceId);
    // A damaged component must be repaired alongside, never over a running version.
    await rm(join(first.runtimeDirectory, 'app/node_modules/@hunterzhu/pulse-server/dist/index.js'));
    await page.evaluate(async () => window.pulseDesktop.request('/api/desktop/setup/repair', { method: 'POST' }));
    const repaired = await ready(page);
    assert.notEqual(repaired.runtimeDirectory, first.runtimeDirectory);
    assert.equal(repaired.service.pid, pid);
    assert.equal(repaired.service.outdated, true);
    assert.equal(await readFile(first.configPath, 'utf8'), config);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve user data');
    assert.equal((await request(page, `/api/conversations/${conversation.id}`)).title, 'Preserve installed history');
    assert.match((await runCli(repaired.cli.path)).stdout, /0\.7\.0/);
    await page.evaluate(() => { history.pushState(null, '', '/settings/desktop'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('button', { name: '应用后台更新', exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-environment-repair.png') });
    console.log(JSON.stringify({ ok: true, packaged: Boolean(process.env.PULSE_DESKTOP_EXECUTABLE), noSystemNodeOrChrome: true, firstRun: true, terminalCommand: true, rememberedDevice: true, bundledBrowser: true, repairsWithoutStoppingBackend: true, preservesConfigAndData: true }));
} catch (error) {
    if (desktop) { const page = await desktop.firstWindow(); console.error(await page.locator('body').innerText()); console.error(JSON.stringify(await status(page))); await page.screenshot({ path: join(tmpdir(), 'pulse-clean-install-failure.png') }); }
    throw error;
} finally {
    await desktop?.close();
    pid ??= await readFile(join(data, 'service.json'), 'utf8').then(value => JSON.parse(value).pid).catch(() => undefined);
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    await new Promise(resolve => website.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 2000));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
