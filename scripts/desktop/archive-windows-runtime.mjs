import { createRequire } from 'node:module';
import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileDigest, readRuntimeManifest, verifyRuntime } from '../../packages/desktop/src/runtime-manifest.mjs';
import { archiveName, archiveMetadataName } from '../../packages/desktop/src/runtime-archive.mjs';

const { c } = createRequire(new URL('../../packages/desktop/package.json', import.meta.url))('tar');

export async function archiveWindowsRuntime(source, destination, arch = process.arch) {
    const manifest = await readRuntimeManifest(source, 'win32', arch);
    await verifyRuntime(source, manifest, true);
    await mkdir(destination, { recursive: true });
    const archive = join(destination, archiveName);
    // One shallow payload bypasses NSIS's temporary extraction + recursive
    // CopyFiles handling of deeply nested node_modules on Windows.
    await c({ cwd: source, file: archive, portable: true }, ['.']);
    await cp(join(source, 'desktop-runtime.json'), join(destination, 'desktop-runtime.json'));
    // Startup diagnostics must be available even before the payload is unpacked.
    for (const name of ['diagnostics.js', 'jarvis/privacy.js']) {
        const relative = 'app/node_modules/@hunterzhu/pulse-server/dist/' + name;
        await mkdir(dirname(join(destination, relative)), { recursive: true });
        await cp(join(source, relative), join(destination, relative), { recursive: true });
    }
    await writeFile(join(destination, archiveMetadataName), JSON.stringify({ schema: 1, sha256: await fileDigest(archive) }));
    return manifest;
}

export default async function afterPack(context) {
    if (context.electronPlatformName !== 'win32') return;
    const source = join(context.appOutDir, 'resources/runtime'), staging = source + '-archive';
    const manifest = JSON.parse(await readFile(join(source, 'desktop-runtime.json'), 'utf8'));
    try {
        await archiveWindowsRuntime(source, staging, manifest.arch);
        await rm(source, { recursive: true, force: true });
        await rename(staging, source);
    } finally { await rm(staging, { recursive: true, force: true }); }
}
