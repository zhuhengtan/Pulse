/** macOS templates use the transparent brand mark, never the app icon's opaque plate. */
export function createTrayIcon(nativeImage, platform, appIcon, templateIcon) {
    if (platform === 'darwin') {
        const image = nativeImage.createFromPath(templateIcon);
        if (image.isEmpty()) throw new Error('TRAY_TEMPLATE_MISSING');
        image.setTemplateImage(true);
        return image;
    }
    return nativeImage.createFromPath(appIcon).resize({ width: 18, height: 18 });
}
