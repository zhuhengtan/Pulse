import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';

const candidates = (port, attempts) => Array.from({ length: Math.min(attempts, 65536 - port) }, (_, index) => port + index);
export function developmentPortAvailable(port, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', error => ['EADDRINUSE', 'EACCES'].includes(error.code) ? resolve(false) : reject(error));
        server.listen(port, host, () => server.close(error => error ? reject(error) : resolve(true)));
    });
}

/** Only choose a port; an unrelated listener is never stopped or reused. */
export async function selectDevelopmentBackendPort(port, explicit = false) {
    for (const candidate of candidates(port, explicit ? 1 : 32)) {
        if (candidate !== 7332 && await developmentPortAvailable(candidate)) return candidate;
    }
    throw new Error(explicit ? `端口 ${port} 已被其他进程占用，未操作该进程。请改用 PULSE_WEB_DEV_PORT 指定空闲端口。` : '附近没有空闲的开发后台端口。');
}

/** Prefer a matching Vite, otherwise a free port. Keep the page path and data directory. */
export async function selectDevelopmentFrontend({ repo, url, backend, explicit = false, attempts = 32 }) {
    const requested = new URL(url), workspace = await realpath(repo), target = new URL(backend).origin;
    const host = requested.hostname.replace(/^\[|\]$/g, '');
    let free;
    for (const port of candidates(Number(requested.port), explicit ? 1 : attempts)) {
        if (port === 7332 || port === Number(new URL(target).port)) continue;
        const candidate = new URL(requested); candidate.port = String(port);
        if (await developmentPortAvailable(port, host)) { free ??= candidate.href; continue; }
        try {
            const options = () => ({ redirect: 'error', signal: AbortSignal.timeout(800) });
            const response = await fetch(new URL('/__pulse_dev', candidate), options());
            const info = response.ok ? await response.json() : undefined;
            if (typeof info?.workspace !== 'string' || info.backend !== target || await realpath(info.workspace) !== workspace) continue;
            const client = await fetch(new URL('/@vite/client', candidate), options());
            if (client.ok && (await client.text()).includes('WebSocket')) return candidate.href;
        } catch { /* Occupied, unresponsive or not this workspace's matching Vite. */ }
    }
    if (free) return free;
    throw new Error(explicit ? '指定的前端端口已被不匹配的服务占用，未操作该进程。' : '附近没有可用的开发前端端口。');
}
