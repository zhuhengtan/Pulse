import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Launch the trusted seed's update core; do not depend on a healthy running server. */
export function controlUpdate(installation, shellVersion, chromium, path, init = {}) {
    const source = installation.source;
    const node = source ? join(source, process.platform === 'win32' ? 'node.exe' : 'node') : installation.node;
    const entry = source ? join(source, 'app/node_modules/@hunterzhu/pulse-server/dist/updates/control.js') : fileURLToPath(new URL('../../server/dist/updates/control.js', import.meta.url));
    return new Promise(resolve => {
        const child = spawn(node, [entry, installation.root, installation.dataDirectory, shellVersion, String(chromium), path, init.method ?? 'GET', init.body ?? '{}'], { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, PULSE_HOME: installation.root, ELECTRON_RUN_AS_NODE: '1', ...(source ? { PULSE_MANAGED: '1' } : {}) } });
        let output = '', settled = false;
        const done = value => { if (settled) return; settled = true; resolve(value); };
        child.stdout.on('data', chunk => { output += chunk; if (output.length > 32 * 1024 * 1024) { child.kill('SIGTERM'); done({ status: 503, body: { error: 'UPDATE_CONTROL_RESPONSE_TOO_LARGE' } }); } });
        child.once('error', () => done({ status: 503, body: { error: 'UPDATE_CONTROL_UNAVAILABLE' } }));
        child.once('exit', () => { try { done(JSON.parse(output)); } catch { done({ status: 503, body: { error: 'UPDATE_CONTROL_UNAVAILABLE' } }); } });
    });
}
