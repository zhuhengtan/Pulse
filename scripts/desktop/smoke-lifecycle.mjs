import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, realpath, stat, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
const execute = promisify(execFile);
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
async function deadline(operation, label, milliseconds = 15000) {
    let timer;
    try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`DESKTOP_CLEANUP_TIMEOUT:${label}`)), milliseconds); })]); }
    finally { clearTimeout(timer); }
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function processTable() {
    if (process.platform === 'win32') {
        const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const command = '$ErrorActionPreference="Stop"; $rows=@(Get-CimInstance Win32_Process | ForEach-Object { $born=$null; if ($_.CreationDate) { $born=$_.CreationDate.ToUniversalTime().ToString("o") }; @{pid=[int]$_.ProcessId; parent=[int]$_.ParentProcessId; born=$born; command=$_.CommandLine} }); ConvertTo-Json -InputObject $rows -Compress';
        const { stdout } = await execute(executable, ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
        const rows = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!Array.isArray(rows)) throw new Error('DESKTOP_PROCESS_TABLE_INVALID');
        return rows;
    }
    const { stdout } = await execute('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,lstart=,command='], { env: { ...process.env, LC_ALL: 'C' }, timeout: 10000, maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim().split('\n').map(line => {
        const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/);
        if (!match) throw new Error('DESKTOP_PROCESS_TABLE_INVALID');
        return { pid: Number(match[1]), parent: Number(match[2]), born: match[3], command: match[4] };
    });
}

async function processArguments(pid) {
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('DESKTOP_PROCESS_IDENTITY_UNKNOWN');
    if (process.platform === 'linux') {
        const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
        if (argv.at(-1) === '') argv.pop(); // Only the kernel's terminating NUL, not empty arguments.
        return argv;
    }
    if (process.platform === 'darwin') {
        // ps prints a lossy joined string. Read the kernel's actual argv vector.
        const program = 'import ctypes,json,struct,sys\nlib=ctypes.CDLL(None,use_errno=True)\nmib=(ctypes.c_int*3)(1,49,int(sys.argv[1]))\nsize=ctypes.c_size_t(1048576)\nbuf=ctypes.create_string_buffer(size.value)\nif lib.sysctl(mib,3,buf,ctypes.byref(size),None,0)!=0: raise OSError(ctypes.get_errno(),"PROCARGS2")\nb=buf.raw[:size.value]; argc=struct.unpack("i",b[:4])[0]; offset=b.index(b"\\0",4)+1\nwhile b[offset]==0: offset+=1\nprint(json.dumps([v.decode("utf-8") for v in b[offset:].split(b"\\0")[:argc]]))';
        const { stdout } = await execute('/usr/bin/python3', ['-c', program, String(pid)], { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
        return JSON.parse(stdout);
    }
    if (process.platform !== 'win32') throw new Error('DESKTOP_PROCESS_PLATFORM_UNSUPPORTED');
    const command = `$ErrorActionPreference="Stop"; Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PulseArgv { [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string s, out int n); [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p); public static string[] Parse(string s) { int n; IntPtr p=CommandLineToArgvW(s,out n); if(p==IntPtr.Zero) throw new Exception("ARGV_UNAVAILABLE"); try { string[] r=new string[n]; for(int i=0;i<n;i++)r[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return r; } finally { LocalFree(p); } } }'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if(!$p.CommandLine){throw 'ARGV_UNAVAILABLE'}; ConvertTo-Json -InputObject @([PulseArgv]::Parse($p.CommandLine)) -Compress`;
    const { stdout } = await execute(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
    return JSON.parse(stdout.replace(/^\uFEFF/, ''));
}

/** Own a fresh, private smoke fixture, including services the desktop restarts.
 * A PID alone never authorizes a signal. Keep product quit/background behavior
 * intact, then verify the descriptor and native process identity before cleanup.
 */
export async function ownSmokeFixture(root, directory, userData) {
    if (!isAbsolute(root) || !isAbsolute(directory) || !isAbsolute(userData)) throw new Error('DESKTOP_FIXTURE_PATH_INVALID');
    const canonical = await realpath(root), initial = await stat(canonical);
    const inside = relative(root, directory);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('DESKTOP_FIXTURE_DATA_OUTSIDE_ROOT');
    const profile = relative(root, userData);
    if (!profile || profile.startsWith('..') || isAbsolute(profile)) throw new Error('DESKTOP_FIXTURE_PROFILE_OUTSIDE_ROOT');
    const data = join(canonical, inside), desktops = [], identities = new Map(), uncertainties = new Map();
    const ownership = join(canonical, profile, `owned-service-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}.json`);
    console.log(`[desktop:cleanup] fixture ${canonical}`);
    const normalize = value => process.platform === 'win32' ? value.replaceAll('\\', '/').toLowerCase() : value;
    const roots = [...new Set([root, canonical].map(normalize))];
    const contains = (command, path) => {
        const value = normalize(command ?? ''), target = normalize(path);
        let offset = -1;
        while ((offset = value.indexOf(target, offset + 1)) >= 0) {
            const before = value[offset - 1], end = value[offset + target.length];
            if ((!before || [' ', '=', '"', "'"].includes(before)) && (!end || ['/', '\\', '"', "'", ' '].includes(end))) return true;
        }
        return false;
    };
    const read = async name => { try { return JSON.parse(await readFile(join(data, name), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
    async function verifyRoot() {
        const current = await stat(canonical);
        if (current.dev !== initial.dev || current.ino !== initial.ino || await realpath(root) !== canonical) throw new Error('DESKTOP_FIXTURE_IDENTITY_CHANGED');
    }
    async function inspect() {
        await verifyRoot();
        const rows = await processTable(), scoped = rows.filter(row => roots.some(path => contains(row.command, path)));
        const unresolved = [];
        for (const [pid, identity] of identities) {
            const current = rows.find(row => row.pid === pid);
            if (!current) {
                // A query snapshot can miss a still-live process. Only explicit
                // ESRCH retires the observed instance; no PID reuse inherits it.
                if (!alive(pid)) { identities.delete(pid); uncertainties.delete(pid); continue; }
                uncertainties.set(pid, { pid, sameBirth: null, command: 'unavailable', query: 'row-missing-pid-alive' });
            } else if (current.born !== identity.born || current.command !== identity.command) {
                // Normal exit can degrade argv before reaping. Neither a changed
                // birth nor empty/defunct text authorizes a signal or deletion.
                uncertainties.set(pid, { pid, sameBirth: current.born === identity.born, command: !current.command ? 'empty' : current.command.includes('<defunct>') ? 'defunct-text' : 'changed', query: 'row-present' });
            }
            // Uncertainty is sticky even if argv later looks familiar again.
            if (uncertainties.has(pid)) unresolved.push(uncertainties.get(pid));
        }
        for (const row of scoped) {
            if (identities.has(row.pid)) continue; // Existing owners remain governed by sticky uncertainty.
            if (!Number.isSafeInteger(row.pid) || row.pid < 1 || !row.born || !row.command) throw new Error('DESKTOP_PROCESS_IDENTITY_UNKNOWN');
            if (row.pid !== process.pid && !identities.has(row.pid)) identities.set(row.pid, row);
        }
        return { rows, unresolved, scoped: scoped.filter(row => row.pid !== process.pid), service: await read('service.json'), writer: await read('.writer.lock') };
    }
    async function stopDesktops() {
        const errors = [];
        for (const { app, child } of desktops) {
            if (child.exitCode !== null || child.signalCode != null) continue;
            const exited = new Promise(resolveExit => child.once('exit', resolveExit));
            try { await deadline(app.close(), 'desktop-close', 5000); await deadline(exited, 'desktop-exit', 5000); }
            catch (error) {
                errors.push(error);
                if (child.exitCode === null && child.signalCode == null) child.kill('SIGKILL');
                try { await deadline(exited, 'forced-desktop-exit', 5000); } catch (cause) { errors.push(cause); }
            }
        }
        if (errors.length) throw new AggregateError(errors, 'DESKTOP_WINDOW_CLEANUP_FAILED');
    }
    async function serviceIdentity(descriptor) {
        if (descriptor.protocol !== 1 || !Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || descriptor.pid === process.pid || typeof descriptor.instanceId !== 'string' || !descriptor.instanceId || !Number.isInteger(descriptor.port) || descriptor.port < 1 || descriptor.port > 65535 || typeof descriptor.dataDir !== 'string' || normalize(await realpath(descriptor.dataDir)) !== normalize(data)) throw new Error('DESKTOP_SERVICE_OWNER_UNKNOWN');
        const receipt = JSON.parse(await readFile(ownership, 'utf8'));
        if (receipt.instanceId !== descriptor.instanceId || receipt.pid !== descriptor.pid || !Number.isSafeInteger(receipt.launchedPid) || ![descriptor.pid, descriptor.supervisorPid].includes(receipt.launchedPid)) throw new Error('DESKTOP_SERVICE_RECEIPT_MISMATCH');
        const base = `http://127.0.0.1:${descriptor.port}`;
        const session = await fetch(`${base}/api/session/local`, { method: 'POST', headers: { Origin: base }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!session.ok) throw new Error('DESKTOP_SERVICE_AUTH_FAILED');
        const cookie = session.headers.get('set-cookie')?.match(/^pulse_device=[^;]+/)?.[0];
        if (!cookie) throw new Error('DESKTOP_SERVICE_COOKIE_MISSING');
        const response = await fetch(`${base}/api/session`, { headers: { Origin: base, Cookie: cookie }, redirect: 'error', signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error('DESKTOP_SERVICE_AUTH_FAILED');
        const authenticated = await response.json();
        const scope = createHash('sha256').update(resolve(descriptor.dataDir)).digest('hex').slice(0, 32);
        if (authenticated.serverPid !== descriptor.pid || authenticated.serverInstanceId !== descriptor.instanceId || authenticated.queueScope !== scope) throw new Error('DESKTOP_SERVICE_AUTH_IDENTITY_MISMATCH');
        const argv = await processArguments(descriptor.pid);
        if (!Array.isArray(argv) || argv.length !== 8 || typeof argv[1] !== 'string' || !normalize(argv[1]).endsWith('/bin.js') || JSON.stringify(argv.slice(2, 7)) !== JSON.stringify(['h5', 'start', '--port', '0', '--data-dir']) || normalize(await realpath(argv[7])) !== normalize(data)) throw new Error('DESKTOP_SERVICE_ARGV_MISMATCH');
        return { receipt, argv };
    }
    async function stopBackends() {
        const until = Date.now() + 30000, signalled = new Set();
        do {
            const state = await inspect(), descriptor = state.service;
            if (descriptor) {
                if (!Number.isSafeInteger(descriptor.pid) || descriptor.pid < 1 || descriptor.pid === process.pid) throw new Error('DESKTOP_SERVICE_OWNER_UNKNOWN');
                const owner = state.rows.find(row => row.pid === descriptor.pid);
                if (owner && !signalled.has(owner.pid)) {
                    const uncertain = state.unresolved.find(row => row.pid === owner.pid);
                    if (uncertain) throw new Error(`DESKTOP_SERVICE_IDENTITY_UNCONFIRMED:${JSON.stringify(uncertain)}`);
                    // Authorization comes from the desktop's ownership receipt and a
                    // live authenticated instance, NOT text in ps or a stale PID file.
                    const identity = await serviceIdentity(descriptor);
                    const fresh = await inspect(), latest = fresh.service, current = fresh.rows.find(row => row.pid === owner.pid);
                    if (fresh.unresolved.some(row => row.pid === owner.pid) || JSON.stringify(latest) !== JSON.stringify(descriptor) || !current || current.born !== owner.born || current.command !== owner.command) throw new Error('DESKTOP_SERVICE_IDENTITY_CHANGED');
                    const confirmed = await serviceIdentity(latest);
                    if (JSON.stringify(confirmed) !== JSON.stringify(identity) || JSON.stringify(await read('service.json')) !== JSON.stringify(latest) || JSON.stringify(JSON.parse(await readFile(ownership, 'utf8'))) !== JSON.stringify(confirmed.receipt)) throw new Error('DESKTOP_SERVICE_IDENTITY_CHANGED');
                    // Node's PID signal API is not atomic with these checks; native
                    // start time is an extra hint, not a claim of a PID-handle lease.
                    if (Date.now() >= until) throw new Error('DESKTOP_BACKEND_IDENTITY_DEADLINE');
                    console.log(`[desktop:cleanup] stop owned backend ${owner.pid}`);
                    try { process.kill(owner.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
                    signalled.add(owner.pid);
                } else if (!owner && alive(descriptor.pid)) throw new Error('DESKTOP_SERVICE_IDENTITY_UNAVAILABLE');
            }
            const backends = state.scoped.filter(row => /\bh5\s+start\b/.test(row.command));
            if (!backends.length && (!descriptor || !alive(descriptor.pid))) return;
            if (Date.now() >= until) throw new Error(`DESKTOP_BACKEND_EXIT_UNCONFIRMED:${JSON.stringify(state.unresolved)}`);
            await pause(100);
        } while (true);
    }
    async function waitForResources() {
        const until = Date.now() + 15000;
        do {
            const state = await inspect();
            if (state.writer) {
                const pid = state.writer.pid;
                if (!Number.isSafeInteger(pid) || pid < 1 || pid === process.pid) throw new Error('DESKTOP_WRITER_OWNER_UNKNOWN');
                const owner = state.rows.find(row => row.pid === pid);
                if (owner && !state.unresolved.some(row => row.pid === pid) && (!/service\.mjs/.test(owner.command ?? '') || !contains(owner.command, directory) && !contains(owner.command, data))) throw new Error('DESKTOP_WRITER_PROCESS_MISMATCH');
                if (!owner && alive(pid)) throw new Error('DESKTOP_WRITER_IDENTITY_UNAVAILABLE');
            }
            if (!state.scoped.length && !state.unresolved.length && (!state.writer || !alive(state.writer.pid))) return;
            if (Date.now() >= until) {
                if (state.unresolved.length) throw new Error(`DESKTOP_RESOURCE_IDENTITY_UNCONFIRMED:${JSON.stringify(state.unresolved)}`);
                throw new Error(`DESKTOP_RESOURCES_STILL_LIVE:${state.scoped.map(row => row.pid).join(',')}`);
            }
            await pause(100);
        } while (true);
    }
    return {
        desktop(app) { desktops.push({ app, child: app.process() }); return app; },
        async finish(failure, { stopServer, closeHost, closeOther } = {}) {
            const errors = [];
            const attempt = async (label, operation) => { if (!operation) return true; try { console.log(`[desktop:cleanup] ${label}`); await deadline(Promise.resolve().then(operation), label, 60000); return true; } catch (error) { errors.push(error); return false; } };
            await attempt('windows', stopDesktops);
            const windowsStopped = desktops.every(({ child }) => child.exitCode !== null || child.signalCode != null);
            const serverStopped = await attempt('server', stopServer);
            const backendsStopped = windowsStopped && serverStopped && await attempt('owned-backends', stopBackends);
            const hostStopped = await attempt('host', closeHost);
            if (backendsStopped && hostStopped) await attempt('data-resources', waitForResources);
            await attempt('other-resources', closeOther);
            if (!errors.length) await attempt('remove-fixture', async () => { await verifyRoot(); await rm(canonical, { recursive: true, force: true, maxRetries: 0 }); });
            if (failure && errors.length) throw new AggregateError([failure, ...errors], 'DESKTOP_SMOKE_AND_CLEANUP_FAILED', { cause: failure });
            if (errors.length) throw new AggregateError(errors, 'DESKTOP_SMOKE_CLEANUP_FAILED');
            if (failure) throw failure;
        },
    };
}

// Exercise both user actions: closing hides the desktop to its tray, while the
// explicit quit menu exits Electron and deliberately leaves the backend alive.
// Windows immersive UI clears the application menu. The real quit item is the
// tray menu rebuilt after the window visibility signature changes.
export async function closeToTray(desktop) {
    await desktop.evaluate(({ Tray, Menu, BrowserWindow }) => {
        if (process.platform === 'win32' && Menu.getApplicationMenu() !== null) throw new Error('WINDOWS_APP_MENU_PRESENT')
        if (!Tray.__pulseCaptureInstalled) {
            const original = Tray.prototype.setContextMenu
            const captured = []
            Tray.__pulseCapturedMenus = captured
            Tray.prototype.setContextMenu = function (menu) {
                const result = original.apply(this, arguments)
                const windows = BrowserWindow.getAllWindows()
                captured.push({ menu, hidden: windows.length > 0 && windows.every(window => !window.isVisible()) })
                return result
            }
            Tray.__pulseCaptureInstalled = true
        }
    })
    await desktop.evaluate(({ BrowserWindow }) => {
        setTimeout(() => { for (const window of BrowserWindow.getAllWindows()) window.close(); }, 0);
    });
    const deadline = Date.now() + 5000;
    do {
        const hidden = await desktop.evaluate(({ BrowserWindow }) => {
            const windows = BrowserWindow.getAllWindows();
            return windows.length > 0 && windows.every(window => !window.isVisible());
        });
        if (hidden) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error('DESKTOP_DID_NOT_HIDE_TO_TRAY');
}

export async function quitFromMenu(desktop) {
    // The tray rebuilds when visibility changes. The service monitor invokes
    // that rebuild within its existing 2s interval, after the probe finishes.
    const deadline = Date.now() + 10000
    do {
        const clicked = await desktop.evaluate(({ Tray }) => {
            const captured = Tray.__pulseCapturedMenus ?? []
            for (let index = captured.length - 1; index >= 0; index--) {
                const entry = captured[index]
                if (!entry.hidden) continue
                const items = []
                const walk = menu => { for (const item of menu?.items ?? []) { items.push(item); if (item.submenu) walk(item.submenu) } }
                walk(entry.menu)
                const hide = items.find(item => item.label === '隐藏桌面窗口')
                const quit = items.find(item => ['彻底退出 Pulse（保留后台服务）', '退出托盘（保留后台服务）'].includes(item.label))
                if (hide?.enabled !== false || !quit?.enabled || typeof quit.click !== 'function') continue
                // Return before the real menu action disconnects the inspector.
                setTimeout(() => quit.click(), 0)
                return true
            }
            return false
        })
        if (clicked) return
        await new Promise(resolve => setTimeout(resolve, 50))
    } while (Date.now() < deadline)
    throw new Error('DESKTOP_QUIT_MENU_MISSING')
}
