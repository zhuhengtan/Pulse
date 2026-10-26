/** A notification cold start opens its own target. Dock and a second instance still reveal the main window while questions are pending. */
export function shouldRevealMain({ ready, notificationLaunch }) {
    return Boolean(ready) && !notificationLaunch;
}
