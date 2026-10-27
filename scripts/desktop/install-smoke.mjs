import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { closeToTray, quitFromMenu } from './smoke-lifecycle.mjs';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { _electron } = createRequire(require.resolve('@playwright/mcp'))('playwright');
const execute = promisify(execFile);
const expectedVersion = JSON.parse(await readFile(new URL('../../packages/cli/package.json', import.meta.url), 'utf8')).version;
const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-clean-install-')));
const install = join(root, '.pulse'), profile = join(root, 'profile'), data = join(install, 'data'), shellHome = join(root, 'shell');
const executablePath = process.env.PULSE_DESKTOP_EXECUTABLE ?? createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
const args = process.env.PULSE_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../../packages/desktop', import.meta.url))];
const env = { ...process.env, PATH: join(root, 'empty-path'), PULSE_HOME: install, PULSE_CONFIG: join(install, 'config.json'), PULSE_DESKTOP_INSTALL_ROOT: install, PULSE_DESKTOP_USER_DATA: profile, PULSE_DESKTOP_DATA_DIR: data, PULSE_DESKTOP_SHELL_HOME: shellHome, ZDOTDIR: shellHome, PULSE_DESKTOP_RUNTIME_DIR: fileURLToPath(new URL('../../artifacts/desktop-runtime/pulse', import.meta.url)), PULSE_ALLOW_NETWORK: '1', PULSE_JARVIS_ENABLED: 'false' };
delete env.ELECTRON_RUN_AS_NODE;
delete env.PULSE_DESKTOP_DEV_URL;
delete env.PULSE_BROWSER_EXECUTABLE;
let desktop, pid, failure, phase = 'initializing';
const instances = [];
const diagnostics = process.env.PULSE_DESKTOP_SMOKE_ARTIFACTS;
async function bounded(promise, label, timeout = 30000) {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`DESKTOP_INSTALL_TIMEOUT:${label}`)), timeout); })]); }
    finally { clearTimeout(timer); }
}
async function step(label, run, timeout) { phase = label; console.log(`[desktop:install] ${label}`); return bounded(Promise.resolve().then(run), label, timeout); }
const website = createServer((_request, response) => response.end('<title>Bundled browser ready</title><h1>Bundled browser ready</h1>'));
async function launch(label) {
    desktop = await step(`${label}:launch`, () => _electron.launch({ executablePath, args, env, timeout: 30000 }), 35000);
    const instance = { app: desktop, process: desktop.process(), exited: undefined };
    instance.exited = new Promise(resolve => instance.process.once('exit', (code, signal) => resolve({ code, signal })));
    instances.push(instance);
    return step(`${label}:first-window`, () => desktop.firstWindow({ timeout: 15000 }), 17000);
}
async function closeWindow(label) {
    const current = desktop, instance = instances.find(item => item.app === current);
    await step(`${label}:close-window-to-tray`, () => closeToTray(current));
    assert.equal(instance.process.exitCode, null);
    await step(`${label}:quit-from-menu`, () => quitFromMenu(current));
    const exit = await step(`${label}:native-exit`, () => instance.exited, 15000);
    assert.deepEqual(exit, { code: 0, signal: null });
    desktop = undefined;
}
async function status(page) { return bounded(page.evaluate(async () => (await window.pulseDesktop.request('/api/desktop/setup')).body), 'setup-snapshot', 5000); }
async function ready(page) {
    const deadline = Date.now() + 180000;
    let value, lastProgress;
    do {
        value = await status(page);
        const runtime = value.steps?.find(item => item.id === 'runtime');
        const progress = JSON.stringify({ phase: value.phase, runtime: runtime?.state, detail: runtime?.detail });
        if (progress !== lastProgress) { console.log(`[desktop:install] ${phase} ${progress}`); lastProgress = progress; }
        if (['ready', 'error'].includes(value.phase)) break;
        await new Promise(resolve => setTimeout(resolve, 300));
    } while (Date.now() < deadline);
    assert.equal(value.phase, 'ready', JSON.stringify(value)); return value;
}
async function request(page, path, body) {
    const value = await step(`request:${path}`, () => page.evaluate(async ({ path, body }) => window.pulseDesktop.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }), { path, body }));
    assert.ok(value.status >= 200 && value.status < 300, JSON.stringify(value.body)); return value.body;
}
try {
    await mkdir(shellHome);
    await new Promise(resolve => website.listen(0, '127.0.0.1', resolve));
    let page = await launch('first');
    const first = await step('first:setup-ready', () => ready(page), 190000);
    assert.equal(first.firstRun, true);
    assert.equal(first.development, false);
    await step('first:welcome', () => page.getByRole('heading', { name: '欢迎使用 Pulse' }).waitFor());
    await page.getByRole('button', { name: '配置模型', exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-first-install.png') });
    const config = await readFile(first.configPath, 'utf8');
    const descriptor = JSON.parse(await readFile(join(data, 'service.json'), 'utf8')); pid = descriptor.pid;
    assert.equal(first.service.pid, pid);
    const runCli = async path => process.platform === 'win32' ? execute(process.env.ComSpec, ['/d', '/s', '/c', `""${path}" --version"`], { env, timeout: 30000, windowsVerbatimArguments: true }) : execute(path, ['--version'], { env, timeout: 30000 });
    assert.ok((await step('first:cli', () => runCli(first.cli.path))).stdout.includes(`Pulse v${expectedVersion}`));
    if (process.platform !== 'win32') {
        const shellResult = await step('first:shell-profile', () => execute('/bin/sh', ['-c', '. "$1"; command -v pulse; pulse --version', 'fixture', join(shellHome, '.profile')], { env, timeout: 30000 }));
        assert.ok(shellResult.stdout.includes(first.cli.path));
    }
    await step('first:enter', () => page.getByRole('button', { name: '稍后配置，进入 Pulse' }).click());
    await step('first:home', () => page.getByRole('heading', { name: '我们要做什么？' }).waitFor());
    const device = await request(page, '/api/session');
    const project = await request(page, '/api/projects', { name: 'Clean install fixture', cwd: root });
    const conversation = await request(page, '/api/conversations', { title: 'Preserve installed history', projectId: project.id });
    await step('native-browser:host', () => page.waitForFunction(async () => (await window.pulseDesktop.request('/api/automation/sessions')).body.nativeBrowser === true));
    const browser = await request(page, '/api/automation/sessions', { kind: 'browser', manual: true, projectId: project.id });
    assert.equal(browser.mode, 'native');
    const control = await request(page, `/api/automation/sessions/${browser.id}/control`, { action: 'takeover' });
    await request(page, `/api/automation/sessions/${browser.id}/command`, { lease: control.lease, method: 'navigate', params: { url: `http://127.0.0.1:${website.address().port}` } });
    await request(page, `/api/automation/sessions/${browser.id}/observe`, {});
    const browsers = await request(page, '/api/automation/sessions');
    assert.ok(browsers.sessions.some(item => item.title === 'Bundled browser ready'));
    await request(page, `/api/automation/sessions/${browser.id}/control`, { action: 'close', lease: control.lease });
    const sentinel = join(data, 'install-preservation-check.txt'); await writeFile(sentinel, 'preserve user data');
    await closeWindow('first');
    process.kill(pid, 0);
    page = await launch('reopen');
    const reopened = await step('reopen:setup-ready', () => ready(page), 190000);
    assert.equal(reopened.firstRun, false);
    assert.equal(reopened.runtimeDirectory, first.runtimeDirectory);
    assert.equal(reopened.service.pid, pid);
    assert.equal((await request(page, '/api/session')).deviceId, device.deviceId);
    // A damaged component must be repaired alongside, never over a running version.
    await rm(join(first.runtimeDirectory, 'app/node_modules/@hunterzhu/pulse-server/dist/index.js'));
    await step('repair:start', () => page.evaluate(async () => window.pulseDesktop.request('/api/desktop/setup/repair', { method: 'POST' })));
    const repaired = await step('repair:setup-ready', () => ready(page), 190000);
    assert.notEqual(repaired.runtimeDirectory, first.runtimeDirectory);
    assert.equal(repaired.service.pid, pid);
    assert.equal(repaired.service.outdated, true);
    assert.equal(await readFile(first.configPath, 'utf8'), config);
    assert.equal(await readFile(sentinel, 'utf8'), 'preserve user data');
    assert.equal((await request(page, `/api/conversations/${conversation.id}`)).title, 'Preserve installed history');
    assert.ok((await step('repair:cli', () => runCli(repaired.cli.path))).stdout.includes(`Pulse v${expectedVersion}`));
    await page.evaluate(() => { history.pushState(null, '', '/settings/desktop'); dispatchEvent(new PopStateEvent('popstate')); });
    await page.getByRole('button', { name: '应用后台更新', exact: true }).waitFor();
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-environment-repair.png') });
    await closeWindow('repaired');
    process.kill(pid, 0);
    console.log(JSON.stringify({ ok: true, packaged: Boolean(process.env.PULSE_DESKTOP_EXECUTABLE), noSystemNodeOrChrome: true, firstRun: true, terminalCommand: true, rememberedDevice: true, bundledBrowser: true, repairsWithoutStoppingBackend: true, preservesConfigAndData: true }));
} catch (error) {
    failure = error;
    console.error(`[desktop:install] failed during ${phase}: ${error.message}`);
    if (diagnostics) { await mkdir(diagnostics, { recursive: true }); await writeFile(join(diagnostics, 'installation-failure.json'), JSON.stringify({ phase, error: error.message, processes: instances.map(item => ({ exitCode: item.process.exitCode, signalCode: item.process.signalCode })) }, null, 2)); }
    if (desktop) {
        const page = await bounded(desktop.firstWindow({ timeout: 1000 }), 'failure-window', 1500).catch(() => undefined);
        if (page) {
            console.error(await bounded(page.locator('body').innerText(), 'failure-body', 3000).catch(() => 'Page unavailable'));
            console.error(JSON.stringify(await status(page).catch(() => undefined)));
            await bounded(page.screenshot({ path: diagnostics ? join(diagnostics, 'installation-failure.png') : join(tmpdir(), 'pulse-clean-install-failure.png') }), 'failure-screenshot', 5000).catch(() => {});
        }
    }
    throw error;
} finally {
    pid ??= await readFile(join(data, 'service.json'), 'utf8').then(value => JSON.parse(value).pid).catch(() => undefined);
    if (pid) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    // Stop the test's background before waiting for automation pipe cleanup.
    let cleanupError;
    for (const { app, process: child } of instances) { try { await bounded(app.close(), 'cleanup-window', 5000); } catch (error) { cleanupError ??= error; if (child.exitCode === null) child.kill('SIGKILL'); } }
    await new Promise(resolve => website.close(resolve));
    await new Promise(resolve => setTimeout(resolve, 2000));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (cleanupError && !failure) throw cleanupError;
}
