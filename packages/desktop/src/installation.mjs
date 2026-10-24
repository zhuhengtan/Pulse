import { access, cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readRuntimeManifest, verifyRuntime } from './runtime-manifest.mjs';

const execute = promisify(execFile);
const marker = 'Pulse Desktop managed launcher';
const exists = path => access(path).then(() => true, () => false);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function atomicJson(path, value) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}`; await writeFile(temp, JSON.stringify(value), { mode: 0o600 }); await rename(temp, path); }
export async function detectCommand(pathValue, windows = process.platform === 'win32') {
    for (const directory of (pathValue ?? '').split(windows ? ';' : delimiter).filter(Boolean)) {
        for (const name of windows ? ['pulse.cmd', 'pulse.exe', 'pulse.bat'] : ['pulse']) {
            const path = resolve(directory, name);
            if (await access(path, windows ? constants.F_OK : constants.X_OK).then(() => true, () => false)) return path;
        }
    }
}
export function launcherText(node, entry, root, windows = process.platform === 'win32', browser, runtimeId, locations = {}) {
    const shared = Object.entries({ PULSE_CONFIG: locations.configPath, PULSE_DATA_DIR: locations.dataDirectory }).filter(([, value]) => value);
    const environment = shared.map(([key, value]) => windows ? `if not defined ${key} set "${key}=${value.replaceAll('%', '%%')}"\r\n` : `if [ -z "\${${key}+x}" ]; then ${key}=${quote(value)}; export ${key}; fi\n`).join('');
    if (windows) {
        // Runtime paths below the managed root have generated, safe basenames.
        const relativeNode = node.slice(root.length + 1).replaceAll('/', '\\'), relativeEntry = entry.slice(root.length + 1).replaceAll('/', '\\');
        return `@echo off\r\nREM ${marker}\r\nsetlocal DisableDelayedExpansion\r\nif not defined PULSE_HOME set "PULSE_HOME=%~dp0.."\r\n${environment}set "ELECTRON_RUN_AS_NODE=1"\r\n${runtimeId ? `set "PULSE_RUNTIME_ID=${runtimeId}"\r\n` : ''}${browser ? `if not defined PULSE_BROWSER_EXECUTABLE set "PULSE_BROWSER_EXECUTABLE=%~dp0..\\${browser.slice(root.length + 1).replaceAll('/', '\\')}"\r\n` : ''}"%~dp0..\\${relativeNode}" "%~dp0..\\${relativeEntry}" %*\r\nexit /b %errorlevel%\r\n`;
    }
    return `#!/bin/sh\n# ${marker}\nif [ -z "\${PULSE_HOME+x}" ]; then PULSE_HOME=${quote(root)}; export PULSE_HOME; fi\n${environment}export ELECTRON_RUN_AS_NODE=1\n${runtimeId ? `export PULSE_RUNTIME_ID=${quote(runtimeId)}\n` : ''}${browser ? `if [ -z "\${PULSE_BROWSER_EXECUTABLE+x}" ]; then PULSE_BROWSER_EXECUTABLE=${quote(browser)}; export PULSE_BROWSER_EXECUTABLE; fi\n` : ''}exec ${quote(node)} ${quote(entry)} "$@"\n`;
}
export async function registerLauncher(root, node, entry, windows = process.platform === 'win32', browser, runtimeId, locations) {
    let conflict;
    const suffix = createHash('sha256').update(node + entry).digest('hex').slice(0, 12);
    for (const name of ['pulse', 'pulse-desktop', `pulse-desktop-${suffix}`]) {
        const path = join(root, 'bin', name + (windows ? '.cmd' : ''));
        await mkdir(dirname(path), { recursive: true });
        const current = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        const text = current?.isFile() ? await readFile(path, 'utf8') : undefined;
        if (current && (!current.isFile() || !text?.includes(marker))) { conflict ??= path; continue; }
        const temp = `${path}.${randomUUID()}`;
        await writeFile(temp, launcherText(node, entry, root, windows, browser, runtimeId, locations), { mode: 0o755 });
        // Recheck immediately before publishing a managed entry.
        if (current && await readFile(path, 'utf8') !== text || !current && await exists(path)) { await rm(temp); throw new Error('CLI_ENTRY_CHANGED'); }
        await rename(temp, path);
        return { path, ...(conflict ? { conflict } : {}) };
    }
    throw new Error('CLI_ENTRY_CONFLICT');
}
const start = '# >>> Pulse Desktop CLI >>>', end = '# <<< Pulse Desktop CLI <<<';
export async function registerPath(bin, home, env = process.env, platform = process.platform, run = execute) {
    if (platform === 'win32') {
        const script = `$p=[string][Environment]::GetEnvironmentVariable('Path','User'); $b=$env:PULSE_SETUP_BIN; if (-not (($p -split ';') | Where-Object { $_.TrimEnd('\\') -ieq $b.TrimEnd('\\') })) { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';')+';'+$b).TrimStart(';')), 'User'); Add-Type -Namespace Pulse -Name EnvironmentBroadcast -MemberDefinition '[System.Runtime.InteropServices.DllImport("user32.dll", CharSet=System.Runtime.InteropServices.CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr h, uint m, System.IntPtr w, string l, uint flags, uint timeout, out System.IntPtr result);'; $r=[IntPtr]::Zero; [void][Pulse.EnvironmentBroadcast]::SendMessageTimeout([IntPtr]65535,26,[IntPtr]::Zero,'Environment',2,5000,[ref]$r) }`;
        const powershell = env.SystemRoot ? join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
        await run(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...env, PULSE_SETUP_BIN: bin }, windowsHide: true, timeout: 10000 });
        return { files: ['用户 PATH'], restartTerminal: true };
    }
    const fish = (env.SHELL ?? '').endsWith('/fish');
    // Creating .bash_profile would suppress an existing .profile on login.
    const bashLogin = await exists(join(home, '.bash_profile')) ? join(home, '.bash_profile') : await exists(join(home, '.bash_login')) ? join(home, '.bash_login') : join(home, '.profile');
    const profiles = fish ? [join(home, '.config/fish/conf.d/pulse.fish')] : [...new Set([
        join(home, '.profile'),
        ...(platform === 'darwin' || (env.SHELL ?? '').endsWith('/zsh') ? [join(env.ZDOTDIR || home, '.zprofile'), join(env.ZDOTDIR || home, '.zshrc')] : []),
        ...(platform !== 'darwin' || (env.SHELL ?? '').endsWith('/bash') ? [join(home, '.bashrc'), bashLogin] : []),
    ])];
    for (const path of profiles) {
        const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
        // Respect shell dotfiles managed via symlinks; give a concrete repair instruction instead.
        if (info?.isSymbolicLink()) throw new Error('SHELL_PROFILE_SYMLINK:' + path);
        const content = info ? await readFile(path, 'utf8') : '';
        const first = content.indexOf(start), last = content.indexOf(end);
        if (first >= 0 && (last < first || content.indexOf(start, first + start.length) >= 0)) throw new Error('SHELL_PROFILE_CONFLICT:' + path);
        const line = fish ? `if not contains -- '${bin.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}' $PATH\n  set -gx PATH $PATH '${bin.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'\nend` : `case ":$PATH:" in *:${quote(bin)}:*) ;; *) export PATH="$PATH":${quote(bin)} ;; esac`;
        const block = `${start}\n${line}\n${end}`;
        const next = first >= 0 ? content.slice(0, first) + block + content.slice(last + end.length) : `${content}${content.endsWith('\n') || !content ? '' : '\n'}\n${block}\n`;
        if (next !== content) { await mkdir(dirname(path), { recursive: true }); const temp = `${path}.${randomUUID()}`; await writeFile(temp, next, { mode: info?.mode ?? 0o600 }); await rename(temp, path); }
    }
    return { files: profiles, restartTerminal: true };
}
export class DesktopInstallation {
    constructor({ root, userData, source, node, entry, shellHome, dataDirectory, packaged = false, env = process.env, platform = process.platform, arch = process.arch }) {
        Object.assign(this, { root, userData, source, node, entry, shellHome, dataDirectory, packaged, env, platform, arch });
        this.state = { phase: 'preparing', firstRun: false, steps: [], development: !packaged && !source };
        this.statePath = join(userData, 'desktop-installation.json');
    }
    snapshot() { return structuredClone(this.state); }
    step(id, label, state, detail = '') {
        const item = { id, label, state, detail };
        const index = this.state.steps.findIndex(value => value.id === id);
        if (index < 0) this.state.steps.push(item); else this.state.steps[index] = item;
    }
    async prepare({ full = false } = {}) {
        if (this.pending) return this.pending;
        this.pending = this.run(full).finally(() => { this.pending = undefined; });
        return this.pending;
    }
    async run(full) {
        this.state.phase = 'preparing'; this.state.error = '';
        const saved = await readFile(this.statePath, 'utf8').then(JSON.parse).catch(() => ({}));
        this.saved = saved; this.state.firstRun = !this.state.development && saved.completed !== true;
        this.state.steps = [];
        try {
            this.step('runtime', '准备 Pulse 运行环境', 'running');
            if (this.source) {
                const manifest = await readRuntimeManifest(this.source, this.platform, this.arch);
                await verifyRuntime(this.source, manifest);
                const release = `${manifest.version}-${manifest.buildId.slice(0, 16)}`;
                const managed = join(this.root, 'desktop', 'runtimes');
                let target = saved.buildId === manifest.buildId && typeof saved.runtimeDirectory === 'string' && dirname(saved.runtimeDirectory) === managed ? saved.runtimeDirectory : join(managed, release);
                this.step('runtime', '准备 Pulse 运行环境', 'running', '正在检查已安装的运行环境');
                const healthy = await verifyRuntime(target, manifest, full).then(() => true, () => false);
                if (!healthy) {
                    this.step('runtime', '准备 Pulse 运行环境', 'running', '正在校验内置文件');
                    await verifyRuntime(this.source, manifest, true);
                    // Never replace files beneath a running backend. A repair gets a fresh immutable directory.
                    if (await exists(target)) target = join(managed, `${release}-repair-${randomUUID()}`);
                    await mkdir(managed, { recursive: true });
                    const staging = join(managed, `.install-${randomUUID()}`);
                    try {
                        this.step('runtime', '准备 Pulse 运行环境', 'running', '正在复制到本地');
                        await cp(this.source, staging, { recursive: true, dereference: false, verbatimSymlinks: true });
                        this.step('runtime', '准备 Pulse 运行环境', 'running', '正在校验安装文件');
                        await verifyRuntime(staging, manifest, true); await rename(staging, target);
                    }
                    finally { await rm(staging, { recursive: true, force: true }); }
                }
                this.node = join(target, this.platform === 'win32' ? 'node.exe' : 'node');
                this.entry = join(target, 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js');
                this.state.version = manifest.version; this.state.buildId = manifest.buildId; this.state.runtimeDirectory = target;
                this.state.runtimeId = createHash('sha256').update(manifest.buildId + target).digest('hex');
                this.browserExecutable = manifest.browserExecutable ? join(target, manifest.browserExecutable) : undefined;
                const version = await execute(this.node, ['--version'], { timeout: 10000, env: { ...this.env, ELECTRON_RUN_AS_NODE: '1' } });
                const match = version.stdout.trim().match(/^v(\d+)\.(\d+)\./);
                if (!match || Number(match[1]) < 22 || Number(match[1]) === 22 && Number(match[2]) < 13) throw new Error('NODE_RUNTIME_UNSUPPORTED');
            } else {
                await access(this.entry);
                this.state.version = 'development';
            }
            this.step('runtime', '准备 Pulse 运行环境', 'ready', this.source ? `内置 Node、CLI 和 Server · ${this.state.version}` : '开发预览，不修改用户的 pulse 命令或 PATH');
            this.step('config', '初始化配置和数据', 'running');
            this.state.configPath = resolve(this.env.PULSE_CONFIG ?? join(this.root, 'config.json'));
            if (!this.state.development) {
                const module = join(dirname(this.entry), 'config.js');
                await execute(this.node, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(module).href)}); await m.ensurePulseUserConfig(${JSON.stringify(this.state.configPath)});`], { env: { ...this.env, PULSE_HOME: this.root, ELECTRON_RUN_AS_NODE: '1' }, timeout: 15000 });
            }
            this.step('config', '初始化配置和数据', 'ready', this.state.configPath);
            if (!this.state.development) {
                this.step('cli', '注册 pulse 命令', 'running');
                this.state.cli = await registerLauncher(this.root, this.node, this.entry, this.platform === 'win32', this.browserExecutable, this.state.runtimeId, { configPath: this.state.configPath, dataDirectory: this.dataDirectory });
                const detected = await detectCommand(this.env.PATH, this.platform === 'win32');
                if (detected && resolve(detected) !== resolve(this.state.cli.path)) this.state.cli.conflict = detected;
                this.step('cli', '注册 pulse 命令', this.state.cli.conflict ? 'warning' : 'ready', this.state.cli.conflict ? `保留已有命令：${this.state.cli.conflict}` : this.state.cli.path);
                try { const path = await registerPath(join(this.root, 'bin'), this.shellHome, this.env, this.platform); this.state.path = { ...path, ready: true }; this.step('path', '配置终端 PATH', 'ready', '新开的终端可运行 pulse；已打开的终端请重新打开'); }
                catch (error) { this.state.path = { ready: false }; this.step('path', '配置终端 PATH', 'warning', `终端配置未修改完成，请将 ${join(this.root, 'bin')} 加入 PATH。`); }
            }
            await atomicJson(this.statePath, { ...saved, version: this.state.version, buildId: this.state.buildId, runtimeDirectory: this.state.runtimeDirectory });
            this.state.phase = 'starting';
        } catch (error) {
            this.state.phase = 'error';
            this.state.error = error.message.startsWith('RUNTIME_PLATFORM') ? '此运行环境与当前系统或处理器不匹配，请下载对应安装包。' : '运行环境准备失败，请点击修复重试。';
            const running = this.state.steps.find(item => item.state === 'running');
            if (running) this.step(running.id, running.label, 'error', this.state.error);
            throw error;
        }
        return this.snapshot();
    }
    async complete() {
        if (this.state.phase !== 'ready') throw new Error('SETUP_NOT_READY');
        await atomicJson(this.statePath, { ...this.saved, version: this.state.version, buildId: this.state.buildId, runtimeDirectory: this.state.runtimeDirectory, completed: true });
        this.state.firstRun = false;
    }
}
