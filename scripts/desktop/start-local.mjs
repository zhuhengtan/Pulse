import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, open, readFile, realpath } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { desktopPageUrl } from '../../packages/desktop/src/dev-url.mjs';
import { assertDesktopDataReady } from '../../packages/desktop/src/data-directory.mjs';
import { stopDevelopmentBackend } from './restart-backend.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const exists = path => access(path).then(() => true, () => false);
const execute = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const listening = port => new Promise(resolveCheck => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolveCheck(value); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false)); socket.setTimeout(1000, () => finish(false));
});
function run(file, args, env) {
    return new Promise((resolveRun, reject) => {
        const child = spawn(file, args, { cwd: repo, stdio: 'inherit', env, shell: process.platform === 'win32' && file === 'pnpm.cmd' });
        let stopped = false;
        const stop = signal => { stopped = true; child.kill(signal); };
        const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
        process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
        const clean = () => { process.off('SIGINT', interrupt); process.off('SIGTERM', terminate); };
        child.once('error', error => { clean(); reject(error); });
        child.once('exit', (code, signal) => {
            clean();
            if (stopped) { reject(Object.assign(new Error('已退出开发启动/预览，现有后台保持运行。'), { code: 'DEV_STOPPED' })); return; }
            code === 0 ? resolveRun() : reject(new Error(`${file} 执行失败（${signal ?? code}）`));
        });
    });
}
async function sessionDescriptor(data) {
    try { return JSON.parse(await readFile(join(data, 'service.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return undefined; throw new Error('无法读取开发后台 service.json，请先检查该文件；脚本不会覆盖它。'); }
}
async function backend(data, requestedPort, env, logs) {
    const saved = await sessionDescriptor(data);
    if (saved && alive(saved.pid)) {
        if (saved.protocol !== 1 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 || saved.port === 7332 || typeof saved.dataDir !== 'string' || await realpath(saved.dataDir) !== await realpath(data)) throw new Error('开发后台描述与当前数据目录不匹配，已保留原进程。');
        if (!await listening(saved.port)) throw new Error('开发后台进程仍存在，但端口未就绪。请检查后台状态；脚本不会自动终止任务。');
        console.log(`复用开发后台：http://127.0.0.1:${saved.port}（PID ${saved.pid}）`);
        console.log('后端代码若有更新，可运行 ./restart-dev.sh 重启开发后台；运行中任务会被中断。');
        return saved.port;
    }
    if (await listening(requestedPort)) throw new Error(`端口 ${requestedPort} 已被其他进程占用，未操作该进程。请改用 PULSE_WEB_DEV_PORT 指定空闲端口。`);
    const log = join(logs, 'backend.log'), output = await open(log, 'a', 0o600);
    let child;
    // Worker mode suppresses pairing URLs/QR credentials in the persistent log;
    // it does not install an operating-system service.
    try { child = spawn(process.execPath, [join(repo, 'packages/cli/dist/bin.js'), 'h5', 'daemon', '--port', String(requestedPort), '--data-dir', data], { cwd: repo, detached: true, stdio: ['ignore', output.fd, output.fd], env }); }
    finally { await output.close(); }
    let failure;
    child.on('error', error => { failure = error; }); child.unref();
    for (let i = 0; i < 600; i++) {
        if (failure || child.exitCode !== null) throw new Error(`后台启动失败，请查看 ${log}`);
        const current = await sessionDescriptor(data);
        if (current?.pid === child.pid && current.protocol === 1 && await listening(current.port)) {
            console.log(`开发后台已启动：http://127.0.0.1:${current.port}（日志 ${log}）`); return current.port;
        }
        await pause(100);
    }
    throw new Error(`后台尚未就绪，请查看 ${log}；不会自动终止可能正在启动的后台。`);
}
async function main() {
    const input = process.argv.slice(2), split = input.indexOf('--');
    const args = split < 0 ? input : input.slice(0, split), electronArgs = split < 0 ? [] : input.slice(split + 1);
    const allowed = new Set(['--help', '-h', '--web-only', '--no-build', '--restart']);
    if (args.some(arg => !allowed.has(arg))) throw new Error('未知参数。运行 ./start-dev.sh --help 查看用法。');
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`用法：./start-dev.sh [--web-only] [--no-build] [--restart]
重启：./restart-dev.sh [--web-only] [--no-build]
默认：准备依赖与编译产物，启动开发后台、Vite 热更新及 Electron。
--web-only  只启动后台和网页，浏览器访问输出的地址。
--no-build  跳过编译，复用已有 dist（首次启动不要使用）。
--restart  构建成功后校验并重启开发后台，保留数据及原端口，复用匹配的 Vite 和窗口；运行中任务会中断。
环境变量：PULSE_DEV_DIR（默认 .pulse-dev）、PULSE_WEB_DEV_PORT（默认 7333）、PULSE_DESKTOP_DEV_URL（默认 http://127.0.0.1:5174/work/new）。
新后台会在退出窗口/脚本后继续运行，可从 Electron 菜单停止。仅本脚本新启动的前端会随窗口/脚本退出停止。`); return;
    }
    if (args.includes('--web-only') && electronArgs.length) throw new Error('--web-only 不能同时传入 Electron 参数。');
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (major < 22 || major === 22 && minor < 13) throw new Error('需要 Node.js >=22.13。');
    const port = Number(process.env.PULSE_WEB_DEV_PORT ?? 7333);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 7332) throw new Error('开发端口须为 1–65535 的整数；7332 保留给正式服务。');
    const url = desktopPageUrl(false, process.env.PULSE_DESKTOP_DEV_URL ?? 'http://127.0.0.1:5174/work/new');
    if (new URL(url).port === String(port)) throw new Error('前端与后台端口不能相同。');
    const dev = resolve(repo, process.env.PULSE_DEV_DIR ?? '.pulse-dev'), data = join(dev, 'h5', 'data'), logs = join(dev, 'logs');
    const env = { ...process.env, PULSE_DATA_DIR: data, PULSE_DESKTOP_DATA_DIR: data, PULSE_DESKTOP_USER_DATA: join(dev, 'electron'), PULSE_H5_HOST: '127.0.0.1', PULSE_DESKTOP_DEV_URL: url };
    delete env.ELECTRON_RUN_AS_NODE; delete env.PULSE_DESKTOP_RUNTIME_DIR;
    const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    try { await execute(pnpm, ['--version'], { shell: process.platform === 'win32' }); } catch { throw new Error('未找到 pnpm，请先安装 pnpm 12.4.2。'); }
    console.log(`Pulse 本地开发环境\n工作区：${repo}\n测试数据：${data}`);
    await mkdir(logs, { recursive: true }); await mkdir(data, { recursive: true }); await assertDesktopDataReady(data);
    const dependencies = ['node_modules/typescript/bin/tsc', 'packages/web/node_modules/vite/package.json', 'packages/server/node_modules/@playwright/mcp/package.json', 'packages/server/node_modules/node-pty/package.json', ...(!args.includes('--web-only') ? ['packages/desktop/node_modules/electron/package.json'] : [])];
    if ((await Promise.all(dependencies.map(path => exists(join(repo, path))))).some(present => !present)) {
        console.log('首次准备项目依赖…'); await run(pnpm, ['install', '--frozen-lockfile', '--ignore-scripts'], env);
    }
    // The terminal native addon must match the Node version running the backend.
    const serverRequire = createRequire(new URL('../../packages/server/package.json', import.meta.url));
    const probe = `const p=require(${JSON.stringify(serverRequire.resolve('node-pty'))}).spawn(process.execPath,['--version'],{});p.onExit(e=>process.exit(e.exitCode));setTimeout(()=>process.exit(1),5000).unref();`;
    try { await execute(process.execPath, ['-e', probe], { env, timeout: 7000 }); }
    catch { console.log('准备终端原生依赖…'); await run(pnpm, ['native:prepare'], env); }
    if (!args.includes('--no-build')) {
        console.log('构建开发产物…');
        await run(pnpm, ['web:build'], env);
        await run(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-b', '--pretty', 'false'], env);
    }
    if (!await exists(join(repo, 'packages/cli/dist/bin.js'))) throw new Error('缺少后台编译产物，请去掉 --no-build 重试。');
    const playwright = createRequire(serverRequire.resolve('@playwright/mcp'));
    const browser = playwright('playwright').chromium.executablePath();
    if (!env.PULSE_BROWSER_EXECUTABLE && !await exists(browser)) {
        console.log('首次准备 Chromium 浏览器…'); await run(process.execPath, [join(dirname(playwright.resolve('playwright/package.json')), 'cli.js'), 'install', 'chromium'], env);
    }
    env.PULSE_BROWSER_EXECUTABLE ??= browser;
    if (!args.includes('--web-only')) {
        const desktopRequire = createRequire(new URL('../../packages/desktop/package.json', import.meta.url));
        let ready = false;
        try { ready = await exists(desktopRequire('electron')); } catch { /* --ignore-scripts omits the Electron binary. */ }
        if (!ready) { console.log('首次准备 Electron…'); await run(process.execPath, [desktopRequire.resolve('electron/install.js')], env); }
    }
    const restartPort = args.includes('--restart') ? await stopDevelopmentBackend({ data, repo, url, port }) : port;
    const actualPort = await backend(data, restartPort, env, logs);
    env.PULSE_H5_TARGET = `http://127.0.0.1:${actualPort}`;
    console.log(`网页预览：${url}\n前端修改自动刷新；新启动后台的日志：${join(logs, 'backend.log')}`);
    await run(process.execPath, [join(repo, 'scripts/desktop/dev.mjs'), ...(args.includes('--web-only') ? ['--web-only'] : electronArgs)], env);
}
main().catch(error => {
    if (error.code === 'DEV_STOPPED') { console.log(error.message); return; }
    console.error(`\n启动未完成：${error.message}`); process.exitCode = 1;
});
