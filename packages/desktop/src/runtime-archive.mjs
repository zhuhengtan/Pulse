import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { x } from 'tar';
import { fileDigest, verifyRuntime } from './runtime-manifest.mjs';

export const archiveName = 'runtime.tar';
export const archiveMetadataName = 'runtime-archive.json';

export async function readRuntimeArchive(source) {
    try {
        const value = JSON.parse(await readFile(join(source, archiveMetadataName), 'utf8'));
        if (value.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.sha256)) throw new Error('INVALID_RUNTIME_ARCHIVE');
        return value;
    } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
    }
}

export async function extractRuntimeArchive(source, destination, metadata, manifest) {
    const file = join(source, archiveName);
    if (await fileDigest(file) !== metadata.sha256) throw new Error('RUNTIME_ARCHIVE_CHANGED');
    // Only regular files/directories from the trusted manifest are accepted.
    // Windows bundles contain no symlinks and require no elevated privileges.
    await x({ file, cwd: destination, strict: true, preservePaths: false,
        filter: (name, entry) => {
            const clean = name.replace(/^\.\//, '').replace(/\/$/, '');
            if (entry.type === 'Directory') return !clean.split('/').some(part => part === '..') && !clean.startsWith('/');
            if (entry.type !== 'File' || (clean !== 'desktop-runtime.json' && !Object.hasOwn(manifest.files, clean))) throw new Error('INVALID_RUNTIME_ARCHIVE_ENTRY');
            return true;
        } });
    await verifyRuntime(destination, manifest, true);
}
