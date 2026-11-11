/** Wait for a child even if it exited just before the listener was attached. */
export function previewProcessExit(child) {
    if (child.exitCode !== null || child.signalCode != null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    return new Promise((resolve, reject) => {
        const error = cause => { child.off('exit', exited); reject(cause); };
        const exited = (code, signal) => { child.off('error', error); resolve({ code, signal }); };
        child.once('error', error); child.once('exit', exited);
    });
}

/** A successful launch may hand off to an already-running tray instance. */
export async function runDesktopPreview({ desktop, vite, interrupted = () => false, log = console.log }) {
    const result = await previewProcessExit(desktop);
    if (interrupted()) return result;
    if (result.code !== 0) throw new Error(`Electron 开发预览退出（${result.signal ?? result.code}）`);
    if (!vite) return result; // A reused frontend belongs to its original launcher.
    log('桌面启动请求已结束（可能已交给托盘中的现有实例）；开发前端继续运行。Ctrl+C 退出本次前端预览，后台保持运行。');
    return previewProcessExit(vite);
}
