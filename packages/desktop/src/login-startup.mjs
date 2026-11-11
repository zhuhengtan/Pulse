import { existsSync } from 'node:fs';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const loginArgs = ['--background'];
export function loginStartupEnabled(app, platform = process.platform) {
    if (platform === 'linux') return existsSync(join(app.getPath('appData'), 'autostart', 'com.hunterzhu.pulse.desktop'));
    // Electron requires Windows reads to use the same args that were registered.
    return (platform === 'win32' ? app.getLoginItemSettings({ args: loginArgs }) : app.getLoginItemSettings()).openAtLogin;
}
export async function setLoginStartup(app, enabled, platform = process.platform) {
    if (platform !== 'linux') { app.setLoginItemSettings({ openAtLogin: enabled, args: loginArgs }); return; }
    const directory = join(app.getPath('appData'), 'autostart'), file = join(directory, 'com.hunterzhu.pulse.desktop');
    if (!enabled) { await rm(file, { force: true }); return; }
    await mkdir(directory, { recursive: true });
    const executable = (process.env.APPIMAGE || app.getPath('exe')).replace(/[\\"`$]/g, '\\$&').replace(/%/g, '%%');
    if (/[\r\n]/.test(executable)) throw new Error('LOGIN_STARTUP_PATH_INVALID');
    await writeFile(file, `[Desktop Entry]\nType=Application\nName=Pulse\nExec="${executable}" --background\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`, { mode: 0o600 });
}
