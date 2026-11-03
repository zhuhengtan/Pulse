/** Keep Windows resize/snap controls while letting the renderer own the title area. */
export function windowChrome(platform, dark = true) {
    return platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: dark ? '#181818' : '#ffffff', symbolColor: dark ? '#ededed' : '#202020', height: 36 }, autoHideMenuBar: true } : {};
}
export function configureWindowChrome(window, platform) {
    if (platform === 'win32') { window.setMenu(null); window.setMenuBarVisibility(false); }
}
