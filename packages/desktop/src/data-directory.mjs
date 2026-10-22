import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

export async function desktopDataDirectory(userData, env, home) {
    const explicit = env.PULSE_DESKTOP_DATA_DIR ?? env.PULSE_DATA_DIR;
    if (explicit) return resolve(explicit);
    const saved = await readFile(join(userData, 'desktop-settings.json'), 'utf8').then(JSON.parse).catch(() => undefined);
    if (typeof saved?.dataDir === 'string' && isAbsolute(saved.dataDir)) return resolve(saved.dataDir);
    return join(env.PULSE_HOME ?? join(home, '.pulse'), 'data');
}

export async function saveDesktopDataDirectory(userData, directory) {
    await mkdir(userData, { recursive: true, mode: 0o700 });
    const path = join(userData, 'desktop-settings.json'), temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ dataDir: resolve(directory) }), { mode: 0o600 });
    await rename(temporary, path);
}

export async function assertDesktopDataReady(directory) {
    const exists = path => access(path).then(() => true, () => false);
    if (await exists(join(directory, 'migration.lock'))) throw new Error('DATA_MIGRATION_IN_PROGRESS');
    if (await exists(join(directory, 'pulse.sqlite'))) return;
    for (const entry of await readdir(join(directory, 'conversations')).catch(() => [])) {
        if (await exists(join(directory, 'conversations', entry, 'manifest.json'))) throw new Error('DATA_MIGRATION_REQUIRED');
    }
}

export function desktopServiceMessage(error) {
    if (error === 'DATA_MIGRATION_REQUIRED') return '所选目录仍是旧版数据，须停用该目录的旧服务并完成迁移后才能连接。也可以选择已经迁移的开发数据目录。';
    if (error === 'DATA_MIGRATION_IN_PROGRESS') return '所选目录正在迁移，请等待迁移完成后重新连接。';
    return `后台服务未能连接（${error || 'PULSE_SERVICE_UNAVAILABLE'}）。请确认数据目录，或稍后重新连接。`;
}
