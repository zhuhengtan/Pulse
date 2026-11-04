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
                const quit = items.find(item => item.label === '退出托盘（保留后台服务）')
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
