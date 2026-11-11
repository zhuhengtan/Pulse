import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { developmentPortAvailable } from './development-endpoints.mjs';

const execute = promisify(execFile), pause = ms => new Promise(done => setTimeout(done, ms));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const request = url => fetch(url, { redirect: 'error', signal: AbortSignal.timeout(2000) });
const escape = text => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');

/** Obtain the actual socket owner, never a PID supplied by an HTTP response. */
export async function inspectFrontendPort(port, platform = process.platform) {
  if (platform === 'win32') {
    const script = `$ids=@(Get-NetTCPConnection -State Listen -LocalPort ${port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if($ids.Count -ne 1){throw 'VITE_OWNER_AMBIGUOUS'}; $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$ids[0]); @{pid=[int]$p.ProcessId;command=$p.CommandLine;executable=$p.ExecutablePath}|ConvertTo-Json -Compress`;
    return JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true })).stdout);
  }
  let pids;
  if (platform === 'linux') {
    const inodes = new Set();
    for (const table of ['tcp', 'tcp6']) {
      const lines = await readFile(`/proc/net/${table}`, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
      for (const line of lines.trim().split('\n').slice(1)) { const fields = line.trim().split(/\s+/); if (fields[3] === '0A' && parseInt(fields[1].split(':').at(-1), 16) === port) inodes.add(`socket:[${fields[9]}]`); }
    }
    pids = [];
    for (const pid of (await readdir('/proc')).filter(name => /^\d+$/.test(name))) {
      const descriptors = await readdir(`/proc/${pid}/fd`).catch(() => []);
      for (const fd of descriptors) if (inodes.has(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''))) { pids.push(Number(pid)); break; }
    }
  } else if (platform === 'darwin') {
    const result = await execute('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], { timeout: 5000 });
    pids = [...new Set(result.stdout.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
  } else throw new Error('VITE_PLATFORM_UNSUPPORTED');
  if (pids.length !== 1) throw new Error('VITE_OWNER_AMBIGUOUS');
  const pid = pids[0];
  if (platform === 'linux') return { pid, argv: (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').filter(Boolean), cwd: await readlink(`/proc/${pid}/cwd`) };
  const [command, executable, cwd] = await Promise.all([
    execute('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 5000 }),
    execute('ps', ['-ww', '-p', String(pid), '-o', 'comm='], { timeout: 5000 }),
    execute('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 5000 }),
  ]);
  return { pid, command: command.stdout.trim(), executable: executable.stdout.trim(), cwd: cwd.stdout.split('\n').find(line => line.startsWith('n'))?.slice(1) };
}

export async function matchesDevelopmentVite({ info, repo, url, entry }) {
  if (!Number.isSafeInteger(info?.pid) || info.pid <= 1) return false;
  if (info.cwd && await realpath(info.cwd) !== await realpath(join(repo, 'packages/web'))) return false;
  const address = new URL(url), args = ['--host', address.hostname, '--port', address.port, '--strictPort'];
  if (info.argv) return ['node', 'node.exe'].includes(basename(info.argv[0])) && await realpath(info.argv[1]).catch(() => '') === await realpath(entry) && JSON.stringify(info.argv.slice(2)) === JSON.stringify(args);
  if (!info.executable || !['node', 'node.exe'].includes(basename(info.executable))) return false;
  const entries = [...new Set([entry, await realpath(entry)])];
  return entries.some(path => new RegExp(`^"?${escape(info.executable)}"?\\s+"?${escape(path)}"?\\s+${args.map(escape).join('\\s+')}\\s*$`).test(info.command));
}

/** Read-only preflight; stopping still rechecks both endpoint and socket owner. */
export async function verifyDevelopmentFrontend({ repo, url, backend, inspect = inspectFrontendPort }) {
  const address = new URL(url), port = Number(address.port), host = address.hostname;
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535 || port === 7332 || port === Number(new URL(backend).port)) throw new Error('开发前端地址不安全，未停止任何进程。');
  if (await developmentPortAvailable(port, host.replace(/^\[|\]$/g, ''))) return undefined;
  const [identity, client] = await Promise.all([request(new URL('/__pulse_dev', address)), request(new URL('/@vite/client', address))]);
  const info = identity.ok ? await identity.json().catch(() => undefined) : undefined;
  if (!info || typeof info.workspace !== 'string' || await realpath(info.workspace) !== await realpath(repo) || info.backend !== new URL(backend).origin || !client.ok || !(await client.text()).includes('WebSocket')) throw new Error('已有开发前端不属于当前仓库或后台，未停止任何进程。');
  const entry = join(dirname(createRequire(join(repo, 'packages/web/package.json')).resolve('vite/package.json')), 'bin/vite.js');
  const owner = await inspect(port);
  if (!await matchesDevelopmentVite({ info: owner, repo, url, entry })) throw new Error('开发前端进程归属无法核验，未停止任何进程。');
  return { pid: owner.pid, port };
}

export async function stopDevelopmentFrontend(options) {
  const { log = console.log, timeoutMs = 15000 } = options;
  const before = options.expected ?? await verifyDevelopmentFrontend(options);
  if (!before) { log('开发前端未运行，将直接启动。'); return; }
  const current = await verifyDevelopmentFrontend(options);
  if (!current || current.pid !== before.pid || current.port !== before.port) throw new Error('开发前端在重启前发生变化，未停止该进程。');
  log(`正在停止开发前端（PID ${before.pid}，端口 ${before.port}）…`);
  process.kill(before.pid, 'SIGTERM');
  const until = Date.now() + timeoutMs;
  while (alive(before.pid) && Date.now() < until) await pause(100);
  if (alive(before.pid)) throw new Error('开发前端未正常退出，未强杀，也未启动第二个前端。');
  if (!await developmentPortAvailable(before.port, new URL(options.url).hostname.replace(/^\[|\]$/g, ''))) throw new Error('开发前端端口尚未释放，未启动第二个前端。');
  log('开发前端已正常退出，将启动新的 Vite。');
}
