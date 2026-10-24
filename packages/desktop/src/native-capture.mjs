import { setTimeout as delay } from 'node:timers/promises';

// Navigation can finish before Chromium has submitted its first composited frame.
// Retry only that transient capture failure, without exposing a hidden browser tab.
export async function captureNativePage(webContents) {
    for (let attempt = 0; ; attempt++) {
        try {
            const image = await webContents.capturePage(undefined, { stayAwake: true });
            if (image.isEmpty()) throw new Error('BROWSER_FRAME_NOT_READY');
            return image;
        } catch (error) {
            if (attempt >= 3 || webContents.isDestroyed() || !['UnknownVizError', 'BROWSER_FRAME_NOT_READY'].includes(error?.message)) throw error;
            await delay(100 * (attempt + 1));
        }
    }
}
