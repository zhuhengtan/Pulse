import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { assertDesktopDataReady, desktopDataDirectory, desktopServiceMessage, saveDesktopDataDirectory } from '../packages/desktop/src/data-directory.mjs';

it('persists an explicit desktop data selection without changing the default data or config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-directory-'));
    try {
        const profile = join(root, 'profile'), dev = join(root, 'dev');
        expect(await desktopDataDirectory(profile, {}, root)).toBe(join(root, '.pulse/data'));
        expect(await desktopDataDirectory(profile, { PULSE_HOME: join(root, 'custom-home') }, root)).toBe(join(root, 'custom-home/data'));
        await saveDesktopDataDirectory(profile, dev);
        expect(await desktopDataDirectory(profile, {}, root)).toBe(dev);
        expect(await desktopDataDirectory(profile, { PULSE_DESKTOP_DATA_DIR: join(root, 'override') }, root)).toBe(join(root, 'override'));
        expect(await readdir(root)).toEqual(['profile']);
        expect(JSON.parse(await readFile(join(profile, 'desktop-settings.json'), 'utf8'))).toEqual({ dataDir: dev });
    } finally { await rm(root, { recursive: true, force: true }); }
});

it('identifies legacy data before launching a backend and preserves every source file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-desktop-legacy-'));
    try {
        const source = join(root, 'conversations', 'conv-old');
        await mkdir(source, { recursive: true });
        await writeFile(join(source, 'manifest.json'), '{"id":"conv-old"}');
        await expect(assertDesktopDataReady(root)).rejects.toThrow('DATA_MIGRATION_REQUIRED');
        expect(await readdir(root)).toEqual(['conversations']);
        expect(await readFile(join(source, 'manifest.json'), 'utf8')).toBe('{"id":"conv-old"}');
        expect(desktopServiceMessage('DATA_MIGRATION_REQUIRED')).toContain('旧版数据');
        await writeFile(join(root, 'pulse.sqlite'), 'migration completed');
        await expect(assertDesktopDataReady(root)).resolves.toBeUndefined();
        await writeFile(join(root, 'migration.lock'), '');
        await expect(assertDesktopDataReady(root)).rejects.toThrow('DATA_MIGRATION_IN_PROGRESS');
    } finally { await rm(root, { recursive: true, force: true }); }
});
