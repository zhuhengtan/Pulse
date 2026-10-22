export function desktopPageUrl(packaged, value) {
    if (packaged || !value) return 'pulse://app/chat';
    const url = new URL(value);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password)
        throw new Error('DESKTOP_DEV_URL_MUST_BE_LOCAL');
    return url.href;
}

export function isDesktopPageUrl(value, pageUrl) {
    if (pageUrl.startsWith('pulse://app/')) return value.startsWith('pulse://app/');
    try {
        const url = new URL(value);
        return !url.username && !url.password && url.origin === new URL(pageUrl).origin;
    } catch { return false; }
}
