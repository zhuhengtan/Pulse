import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

// Each data directory has a separate credential jar. Loopback ports may change
// when the service restarts; the server's data identity remains stable.
export function deviceSessionPartition(directory) {
    return `persist:pulse-api-${createHash('sha256').update(resolve(directory)).digest('hex').slice(0, 24)}`;
}
export async function restoreDeviceCookie(cookies, base) {
    const values = await cookies.get({ url: base, name: 'pulse_device' });
    return values[0]?.value ? `pulse_device=${values[0].value}` : '';
}
export async function saveDeviceCookie(cookies, base, header) {
    const credential = header.split(';')[0];
    if (!credential.startsWith('pulse_device=')) return;
    const value = credential.slice('pulse_device='.length);
    await cookies.set({ url: base, name: 'pulse_device', value, httpOnly: true, sameSite: 'strict', expirationDate: Date.now() / 1000 + 31536000 });
    await cookies.flushStore();
}
