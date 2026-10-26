export function isOwnedService(descriptor, launchedPid, authenticatedPid) {
    return Boolean(Number.isInteger(launchedPid) && Number.isInteger(authenticatedPid) && descriptor?.protocol === 1 && descriptor.pid === authenticatedPid && (descriptor.pid === launchedPid || descriptor.supervisorPid === launchedPid));
}
const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export function cliShellCommand(node, entry, environment) {
    return ['env', 'ELECTRON_RUN_AS_NODE=1', ...Object.entries(environment).map(([key, value]) => `${key}=${quote(value)}`), quote(node), quote(entry)].join(' ');
}
const quoteCmd = value => '"' + String(value).replace(/[\r\n"]/g, '') + '"';
/** Windows terminals do not understand the POSIX env command. Keep the same node, entry and data directory. */
export function cliWindowsScript(node, entry, environment) {
    const assign = (key, value) => `set "${key}=${String(value).replace(/[\r\n"]/g, '')}"`;
    const lines = ['@echo off', assign('ELECTRON_RUN_AS_NODE', '1')];
    for (const [key, value] of Object.entries(environment)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) lines.push(assign(key, value));
    lines.push(`${quoteCmd(node)} ${quoteCmd(entry)}`, 'pause', '');
    return lines.join('\r\n');
}
/** A failed session probe must retry. Only an explicit stop or an in-flight setup pauses the monitor. */
export function serviceMonitorAction({ stoppedByUser, setupPending, base }) {
    if (stoppedByUser || setupPending) return 'wait';
    return base ? 'probe' : 'reconnect';
}

export function restoreOwnedService(descriptor, saved, authenticatedPid, instanceId) {
    if (!instanceId || descriptor?.instanceId !== instanceId || saved?.instanceId !== instanceId || saved?.pid !== descriptor?.pid) return undefined;
    return isOwnedService(descriptor, saved.launchedPid, authenticatedPid) ? saved.launchedPid : undefined;
}

/** Observe only the child we just launched; no process discovery or termination. */
export function observeServiceStartup(child, log) {
    let failure;
    child.once('error', error => {
        failure = `PULSE_SERVICE_START_ERROR:${/^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'SPAWN_FAILED'}`;
        log?.record('spawn-error', { code: error.code, message: error.message });
    });
    child.once('exit', (code, signal) => {
        failure ??= `PULSE_SERVICE_EXITED:${code ?? signal ?? 'unknown'}`;
        log?.record('service-exit', { pid: child.pid, code, signal });
    });
    return () => failure;
}
