import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { desktopPageUrl } from '../../packages/desktop/src/dev-url.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const url = desktopPageUrl(false, process.env.PULSE_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5174/work/new?workspace=preview');
const origin = new URL(url).origin;
let vite;
const ready = async () => {
    try { const response = await fetch(origin + '/@vite/client', { signal: AbortSignal.timeout(1500) }); return response.ok && (await response.text()).includes('WebSocket'); }
    catch { return false; }
};
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
const env = { ...process.env, PULSE_DESKTOP_DEV_URL: url, PULSE_DESKTOP_USER_DATA: process.env.PULSE_DESKTOP_USER_DATA ?? join(repo, '.pulse-dev', 'electron'), PULSE_DESKTOP_DATA_DIR: process.env.PULSE_DESKTOP_DATA_DIR ?? join(repo, '.pulse-dev', 'h5', 'data') };
delete env.ELECTRON_RUN_AS_NODE;
const electron = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('electron');
const desktop = spawn(electron, [...process.argv.slice(2).filter(value => value !== '--'), join(repo, 'packages/desktop')], { cwd: repo, stdio: 'inherit', env });
desktop.on('error', error => { console.error(error.message); vite?.kill('SIGTERM'); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => desktop.kill(signal));
desktop.on('exit', code => { vite?.kill('SIGTERM'); process.exitCode = code ?? 0; });
console.log(`Electron 开发预览：${url}（Vite 自动刷新）`);
