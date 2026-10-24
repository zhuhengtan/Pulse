import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createLocalHost, H5Server } from '../../packages/server/dist/index.js';
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { _electron } = createRequire(require.resolve('@playwright/mcp'))('playwright');
const electronPath = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-smoke-')), directory = join(root, 'data');
const host = createLocalHost({ cwd: root, dataDir: directory, provider: { provider: 'mock', defaultModel: 'mock' }, providerProfiles: { mock: { provider: 'mock', defaultModel: 'mock' } }, providerModels: { mock: { provider: 'mock', model: 'mock' } }, activeModel: 'mock', assistantModel: 'mock', mockResponse: 'Desktop socket reply', jarvis: { enabled: false } });
const server = new H5Server(host, { dataDir: directory, port: 0, host: '127.0.0.1' });
let desktop;
let page, timeline;
const diagnostics = process.env.PULSE_DESKTOP_SMOKE_ARTIFACTS;
async function stopTimeline() {
    if (!timeline || !diagnostics) return;
    const session = timeline; timeline = undefined;
    let finish, timer;
    const completed = new Promise((resolve, reject) => {
        finish = resolve;
        timer = setTimeout(() => reject(new Error('DESKTOP_TRACE_STOP_TIMEOUT')), 10000);
        session.once('Tracing.tracingComplete', finish);
    });
    let stream;
    try { [, { stream }] = await Promise.all([session.send('Tracing.end'), completed]); }
    finally { clearTimeout(timer); session.removeListener('Tracing.tracingComplete', finish); }
    const chunks = [];
    try {
        for (;;) {
            const part = await session.send('IO.read', { handle: stream });
            chunks.push(Buffer.from(part.data, part.base64Encoded ? 'base64' : 'utf8'));
            if (part.eof) break;
        }
    } finally { await session.send('IO.close', { handle: stream }); await session.detach(); }
    await mkdir(diagnostics, { recursive: true });
    await writeFile(join(diagnostics, 'renderer-trace.json'), Buffer.concat(chunks));
}
try {
    await host.init();
    await server.start();
    const inbox = await host.conversationData.call('readState', 'assistant-inbox');
    await host.conversationData.call('replace', inbox.conversationId, Array.from({ length: 120 }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Local history ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), displayVersion: 1 })));
    const work = await host.createConversation({ title: 'Large local work history', projectId: null });
    await host.conversationData.call('replace', work.id, Array.from({ length: 10000 }, (_, i) => ({ id: `work-${i}`, role: i % 2 ? 'assistant' : 'user', text: `Work history ${i}`, createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), displayVersion: 1 })));
    server.assistantView = async () => { throw new Error('DESKTOP_MUST_NOT_READ_SERVER_HISTORY'); };
    const env = { ...process.env, PULSE_DESKTOP_USER_DATA: join(root, 'user-data'), PULSE_DESKTOP_DATA_DIR: directory, PULSE_HOME: join(root, 'home') };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await _electron.launch({ executablePath: process.env.PULSE_DESKTOP_EXECUTABLE ?? electronPath, args: process.env.PULSE_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env, timeout: 20000 });
    page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.getByText('Local history 119', { exact: true }).waitFor({ timeout: 20000 });
    if (await page.locator('.message').count() > 60)
        throw new Error('HISTORY_NOT_PAGINATED');
    await page.locator('[contenteditable=true]').fill('Desktop socket message');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('Desktop socket reply', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('.run-trace.outcome-succeeded').first().waitFor({ timeout: 10000 });
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-chat.png') });
    await page.evaluate(id => { history.pushState(null, '', `/work/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, work.id);
    await page.getByText('Work history 9999', { exact: true }).waitFor({ timeout: 10000 });
    if (diagnostics) {
        timeline = await page.context().newCDPSession(page);
        const categories = ['devtools.timeline', 'blink.user_timing', ...(process.env.PULSE_DESKTOP_CPU_PROFILE === '1' ? ['v8', 'disabled-by-default-v8.cpu_profiler'] : [])];
        await timeline.send('Tracing.start', { transferMode: 'ReturnAsStream', categories: categories.join(',') });
    }
    await page.evaluate(() => { window.__pulseLongTasks = []; if (PerformanceObserver.supportedEntryTypes.includes('longtask'))
        new PerformanceObserver(list => window.__pulseLongTasks.push(...list.getEntries().map(item => item.duration))).observe({ type: 'longtask', buffered: false }); });
    const switches = [];
    for (let i = 0; i < 30; i++) {
        const start = performance.now();
        await page.evaluate(path => { history.pushState(null, '', path); dispatchEvent(new PopStateEvent('popstate')); }, i % 2 ? `/work/${work.id}` : '/chat');
        await page.getByText(i % 2 ? 'Work history 9999' : 'Desktop socket reply', { exact: true }).waitFor({ timeout: 10000 });
        switches.push(performance.now() - start);
    }
    const switchP95Ms = [...switches].sort((a, b) => a - b)[Math.floor(switches.length * .95)];
    for (let i = 0; i < 5; i++) {
        await page.getByRole('button', { name: '加载更早消息', exact: true }).click();
        await page.getByRole('button', { name: '加载更早消息', exact: true }).waitFor({ timeout: 5000 });
        await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '加载更早消息')?.disabled);
    }
    const virtualNodes = await page.locator('.message').count();
    if (virtualNodes > 120)
        throw new Error('LONG_HISTORY_NOT_WINDOWED');
    const maxLongTaskMs = await page.evaluate(() => Math.max(0, ...window.__pulseLongTasks));
    if (diagnostics) {
        await mkdir(diagnostics, { recursive: true });
        await writeFile(join(diagnostics, 'performance.json'), JSON.stringify({ switchP95Ms, maxLongTaskMs, virtualNodes, switches, longTasks: await page.evaluate(() => window.__pulseLongTasks) }, null, 2));
        await stopTimeline();
    }
    if (maxLongTaskMs > 200)
        throw new Error(`FRONTEND_LONG_TASK:${maxLongTaskMs}`);
    await page.screenshot({ path: join(tmpdir(), 'pulse-desktop-work.png') });
    const execution = await host.createConversation({ title: 'Desktop execution', projectId: null });
    await page.evaluate(id => { history.pushState(null, '', `/work/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, execution.id);
    await page.locator('[contenteditable=true]').fill('Show a short status');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByText('Desktop socket reply', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('.run-trace.outcome-succeeded').first().waitFor({ timeout: 10000 });
    const saved = await host.getConversationMessages(execution.id);
    if (!saved.some(message => message.role === 'user' && message.text === 'Show a short status') || !saved.some(message => message.role === 'assistant'))
        throw new Error('DESKTOP_WORK_NOT_PERSISTED');
    await desktop.close();
    desktop = undefined;
    // Closing Electron does not stop the independent service.
    const session = await fetch(`http://127.0.0.1:${server.effectivePort}/api/session/local`, { method: 'POST', headers: { Origin: `http://127.0.0.1:${server.effectivePort}` } });
    if (!session.ok)
        throw new Error('SERVICE_STOPPED_WITH_WINDOW');
    desktop = await _electron.launch({ executablePath: process.env.PULSE_DESKTOP_EXECUTABLE ?? electronPath, args: process.env.PULSE_DESKTOP_EXECUTABLE ? [] : [fileURLToPath(new URL('../../packages/desktop', import.meta.url))], env, timeout: 20000 });
    page = await desktop.firstWindow();
    await page.getByText('Desktop socket reply', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('.run-trace.outcome-succeeded').first().waitFor({ timeout: 10000 });
    await page.evaluate(id => { history.pushState(null, '', `/work/${id}`); dispatchEvent(new PopStateEvent('popstate')); }, work.id);
    await page.getByText('Work history 9999', { exact: true }).waitFor({ timeout: 10000 });
    await server.stop();
    await page.reload();
    await page.getByText('Work history 9999', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('后台服务未连接，仍可浏览本地记录。', { exact: true }).waitFor({ timeout: 10000 });
    await desktop.close();
    desktop = undefined;
    if (errors.length)
        throw new Error(errors.join('\n'));
    console.log(JSON.stringify({ ok: true, localHistoryBypassesServer: true, chatWebSocket: true, workPostSse: true, workMessages: 10000, rapidSwitches: 30, switchP95Ms, maxLongTaskMs, virtualNodes, serviceSurvivesWindow: true, offlineHistoryAfterReload: true, screenshots: [join(tmpdir(), 'pulse-desktop-chat.png'), join(tmpdir(), 'pulse-desktop-work.png')] }));
}
catch (error) {
    if (diagnostics) {
        await mkdir(diagnostics, { recursive: true }).catch(() => {});
        await page?.screenshot({ path: join(diagnostics, 'failure.png') }).catch(() => {});
        await stopTimeline().catch(() => {});
    }
    throw error;
}
finally {
    await desktop?.close();
    await server.stop();
    await host.close();
    await new Promise(r => setTimeout(r, 1700));
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
