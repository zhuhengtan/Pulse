// Exercise both user actions: closing hides the desktop to its tray, while the
// explicit quit menu exits Electron and deliberately leaves the backend alive.
export async function closeToTray(desktop) {
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
    await desktop.evaluate(({ Menu }) => {
        const menu = Menu.getApplicationMenu();
        const quit = menu?.items.flatMap(item => item.submenu?.items ?? [])
            .find(item => item.label === '退出托盘（保留后台服务）');
        if (!quit || !quit.enabled || typeof quit.click !== 'function') throw new Error('DESKTOP_QUIT_MENU_MISSING');
        // Return the inspector result before the application's real menu action
        // disconnects it; the caller separately asserts native exit code zero.
        setTimeout(() => quit.click(), 0);
    });
}
