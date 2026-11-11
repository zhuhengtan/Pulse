import { readFile, readlink, realpath } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile), pause = ms => new Promise(done => setTimeout(done, ms));
const canonical = path => realpath(path).catch(error => { if (error.code === 'ENOENT') return resolve(path); throw error; });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const request = (origin, path, token, method = 'GET') => fetch(origin + path, { method, headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(3000) });
const manualQuit = '请从应用菜单或托盘选择“彻底退出 Pulse（保留后台服务）”后重试；macOS 开发版的应用菜单在屏幕左上角，名称为 Electron。';

/** A successful secondary-instance handoff is not a successful restart. */
export async function waitForFreshDevelopmentDesktop({ child, userData, timeoutMs = 15000 }) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child.exitCode !== null || child.signalCode != null) throw new Error(`新开发桌面未启动，可能仍被旧托盘实例接管。${manualQuit}`);
    const saved = await readFile(join(userData, 'development-desktop.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (saved?.protocol === 1 && saved.pid === child.pid) return;
    await pause(100);
  }
  throw new Error('新开发桌面身份尚未就绪，请检查启动日志；未将托盘复用当作重启成功。');
}

/** Older development shells have no control endpoint. Identify the exact
 * launcher and profile so their one-time manual migration can be explained. */
export async function legacyDesktopIdentity({ userData, appPath, executable, platform = process.platform, inspect = async pid => {
  const [command, files] = await Promise.all([execute('ps', ['-ww', '-p', String(pid), '-o', 'command='], { timeout: 3000 }), execute('lsof', ['-a', '-p', String(pid), '-Fn'], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 })]);
  return { command: command.stdout.trim(), files: files.stdout.split('\n').filter(line => line.startsWith('n')).map(line => line.slice(1)) };
} }) {
  let lock;
  try { lock = await readlink(join(userData, 'SingletonLock')); } catch (error) { if (error.code === 'ENOENT' || platform === 'win32') return undefined; throw error; }
  const pid = Number(lock.match(/-(\d+)$/)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 1 || !alive(pid)) return undefined;
  if (!['darwin', 'linux'].includes(platform)) throw new Error(`旧开发桌面无法自动核验。${manualQuit}`);
  const found = await inspect(pid), profile = await canonical(userData);
  const commands = [`${executable} ${appPath}`, `${await canonical(executable)} ${await canonical(appPath)}`];
  if (!commands.includes(found.command) || !found.files.some(path => path.startsWith(profile + sep))) throw new Error(`开发桌面进程归属无法核验，未停止该进程。${manualQuit}`);
  return pid;
}

export async function stopDevelopmentDesktop({ userData, appPath, executable, timeoutMs = 15000, log = console.log }) {
  let saved;
  try { saved = JSON.parse(await readFile(join(userData, 'development-desktop.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('开发桌面描述文件无效，未停止任何桌面进程。'); }
  if (saved && (!Number.isSafeInteger(saved.pid) || saved.pid <= 1 || saved.protocol !== 1 || typeof saved.appPath !== 'string' || typeof saved.userData !== 'string' || await canonical(saved.appPath) !== await canonical(appPath) || await canonical(saved.userData) !== await canonical(userData) || !Number.isInteger(saved.port) || saved.port < 1 || saved.port > 65535 || !/^[a-f0-9]{64}$/.test(saved.token))) throw new Error('开发桌面身份或配置目录不匹配，未停止任何桌面进程。');
  let pid, quit;
  if (saved && alive(saved.pid)) {
    const origin = `http://127.0.0.1:${saved.port}`;
    const identity = await request(origin, '/identity', saved.token).then(async response => response.ok ? response.json() : undefined).catch(() => undefined);
    if (!identity || identity.protocol !== 1 || identity.pid !== saved.pid || await canonical(identity.appPath ?? '') !== await canonical(appPath) || await canonical(identity.userData ?? '') !== await canonical(userData)) throw new Error(`开发桌面身份核验失败，未停止任何桌面进程。${manualQuit}`);
    pid = saved.pid; quit = async () => { const response = await request(origin, '/quit', saved.token, 'POST'); if (!response.ok) throw new Error('开发桌面拒绝重启请求。'); };
  } else {
    const legacy = await legacyDesktopIdentity({ userData, appPath, executable });
    // Old before-quit handlers turn OS quit signals into a tray hide. Do not
    // signal or force-kill them, and do not restart the backend first.
    if (legacy) throw new Error(`旧开发桌面（PID ${legacy}）尚不支持重启控制。${manualQuit}只需手动退出这一次，再运行 restart-dev，后续可自动重启桌面。后台尚未重启。`);
  }
  if (!pid) { log('开发桌面未运行，将直接启动。'); return; }
  log(`正在退出旧开发桌面（PID ${pid}），以加载主进程及语音组件；保留桌面配置与后台数据。`);
  await quit();
  const until = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < until) await pause(100);
  if (alive(pid)) throw new Error(`开发桌面未正常退出，未强杀，也未启动第二个桌面。${manualQuit}`);
  log('旧开发桌面已退出，将启动当前源码。');
}
