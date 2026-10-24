import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPageUrl } from '../../packages/desktop/src/dev-url.mjs';
import { realpath } from 'node:fs/promises';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const url = desktopPageUrl(false, process.env.PULSE_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5174/work/new');
const origin = new URL(url).origin;
const backend = new URL(process.env.PULSE_H5_TARGET ?? 'http://127.0.0.1:7333').origin;
const webOnly = process.argv.includes('--web-only');
let vite, desktop, interrupted = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { interrupted = true; desktop?.kill(signal); vite?.kill(signal); });
const ready = async () => {
    if (interrupted) throw new Error('开发预览已退出。');
    let response;
    try { response = await fetch(origin + '/@vite/client', { signal: AbortSignal.timeout(1500) }); }
    catch { return false; }
    if (!response.ok || !(await response.text()).includes('WebSocket')) return false;
    const info = await fetch(origin + '/__pulse_dev', { signal: AbortSignal.timeout(1500) }).then(value => value.json()).catch(() => undefined);
    if (!info?.workspace || await realpath(info.workspace).catch(() => '') !== await realpath(repo)) throw new Error(`端口 ${new URL(origin).port} 不是当前仓库的开发前端，请使用其他 PULSE_DESKTOP_DEV_URL。`);
    if (info.backend !== backend) throw new Error(`已有前端连接 ${info.backend}，当前后台为 ${backend}。请使用其他前端端口，避免连接到错误的数据。`);
    return true;
};
try {
if (!await ready()) {
    const address = new URL(origin);
    const entry = join(dirname(createRequire(new URL('../../packages/web/package.json', import.meta.url)).resolve('vite/package.json')), 'bin/vite.js');
    vite = spawn(process.execPath, [entry, '--host', address.hostname, '--port', address.port, '--strictPort'], { cwd: join(repo, 'packages/web'), stdio: 'inherit', env: process.env });
    for (let attempt = 0; attempt < 100 && !await ready(); attempt++) {
        if (vite.exitCode !== null) throw new Error('VITE_START_FAILED');
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!await ready()) { vite.kill('SIGTERM'); throw new Error('VITE_START_TIMEOUT'); }
}
if (webOnly) {
    console.log(`网页开发预览：${url}（Vite 自动刷新）`);
    if (vite) {
        await new Promise((resolveExit, reject) => { vite.once('error', reject); vite.once('exit', code => { process.exitCode = code ?? 0; resolveExit(); }); });
    } else console.log('复用已有前端，退出本脚本不会停止它。');
} else {
const env = { ...process.env, PULSE_DESKTOP_DEV_URL: url, PULSE_DESKTOP_USER_DATA: process.env.PULSE_DESKTOP_USER_DATA ?? join(repo, '.pulse-dev', 'electron'), PULSE_DESKTOP_DATA_DIR: process.env.PULSE_DESKTOP_DATA_DIR ?? join(repo, '.pulse-dev', 'h5', 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const electron = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
desktop = spawn(electron, [...process.argv.slice(2).filter(value => value !== '--'), join(repo, 'packages/desktop')], { cwd: repo, stdio: 'inherit', env });
desktop.on('error', error => { console.error(error.message); vite?.kill('SIGTERM'); process.exitCode = 1; });
desktop.on('exit', code => { vite?.kill('SIGTERM'); process.exitCode = code ?? 0; });
console.log(`Electron 开发预览：${url}（Vite 自动刷新）`);
await new Promise(resolveExit => { desktop.once('error', resolveExit); desktop.once('exit', resolveExit); });
}
} finally { vite?.kill('SIGTERM'); }
