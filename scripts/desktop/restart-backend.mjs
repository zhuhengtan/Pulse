import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const alive = pid => {
    try { process.kill(pid, 0); return true; }
    catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
const canonical = path => realpath(path).catch(error => { if (error.code === 'ENOENT') return resolve(path); throw error; });
const request = (url, init = {}) => fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(3000) });

/** Restart only a verified development backend. Never signal a PID based on a stale file alone. */
export async function stopDevelopmentBackend({ data, repo, url, port }) {
    const directory = await canonical(data);
    for (const production of [join(homedir(), '.pulse', 'data'), join(process.env.PULSE_HOME ?? join(homedir(), '.pulse'), 'data')]) {
        if (directory === await canonical(production)) throw new Error('拒绝重启正式数据目录，请检查 PULSE_DEV_DIR。');
    }
    let saved;
    try { saved = JSON.parse(await readFile(join(data, 'service.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取开发后台 service.json，未停止任何进程。'); }
    if (saved && (saved.protocol !== 1 || !Number.isInteger(saved.pid) || saved.pid <= 1 || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 || saved.port === 7332 || typeof saved.dataDir !== 'string' || await canonical(saved.dataDir) !== directory)) {
        throw new Error('开发后台身份或数据目录不匹配，未停止任何进程。');
    }
    const running = saved && alive(saved.pid);
    const actualPort = running ? saved.port : port;
    const origin = `http://127.0.0.1:${actualPort}`;
    // Check the reused frontend before stopping the backend; a conflicting Vite
    // must not leave the current environment partially stopped.
    let frontend;
    try { frontend = await request(new URL('/__pulse_dev', url)); }
    catch (error) { if (error.cause?.code !== 'ECONNREFUSED') throw new Error('无法核验已有开发前端，未停止后台。'); }
    if (frontend) {
        const info = await frontend.json().catch(() => undefined);
        if (!frontend.ok || typeof info?.workspace !== 'string' || await canonical(info.workspace) !== await canonical(repo) || info.backend !== origin) throw new Error('已有前端不属于当前仓库或连接了其他后台，未停止任何进程。');
    }
    if (!running) { console.log('开发后台未运行，将直接启动。'); return actualPort; }
    // Keep the short-lived local cookie in memory; never print or persist it.
    const local = await request(origin + '/api/session/local', { method: 'POST', headers: { Origin: origin } });
    const cookie = local.headers.get('set-cookie')?.split(';')[0];
    if (!local.ok || !cookie) throw new Error('无法核验开发后台身份，未停止任何进程。');
    const response = await request(origin + '/api/session', { headers: { Cookie: cookie } });
    const info = await response.json();
    const scope = createHash('sha256').update(resolve(saved.dataDir)).digest('hex').slice(0, 32);
    if (!response.ok || !info.localAdmin || info.serverPid !== saved.pid || info.queueScope !== scope) throw new Error('开发后台身份核验失败，未停止任何进程。');
    const current = JSON.parse(await readFile(join(data, 'service.json'), 'utf8'));
    if (current.pid !== saved.pid || current.port !== saved.port || current.dataDir !== saved.dataDir) throw new Error('开发后台在重启前发生变化，请重试；未停止任何进程。');
    console.log(`正在停止开发后台（PID ${saved.pid}，端口 ${actualPort}）；运行中任务会中断，聊天记录和配置保留。`);
    process.kill(saved.pid, 'SIGTERM');
    for (let attempt = 0; attempt < 300; attempt++) {
        if (!alive(saved.pid)) { console.log('开发后台已正常退出。'); return actualPort; }
        await pause(100);
    }
    throw new Error('开发后台 30 秒内未退出；未强制终止，也未启动第二个后台。请检查日志。');
}
