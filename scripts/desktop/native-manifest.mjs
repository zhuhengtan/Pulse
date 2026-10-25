import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileDigest, runtimeFile } from '../../packages/desktop/src/runtime-manifest.mjs';

async function readNative(runtime, platform, arch) {
    const root = join(runtime, 'app/node_modules/@hunterzhu/pulse-server/native', `${platform}-${arch}`);
    const file = join(root, 'manifest.json');
    const manifest = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(manifest.protocolVersion, 1);
    assert.equal(manifest.platform, platform);
    assert.equal(manifest.arch, arch);
    assert.ok(manifest.hashes?.[`pulse-desktop-helper${platform === 'win32' ? '.exe' : ''}`], 'Native helper missing from manifest');
    return { root, file, manifest };
}

export async function refreshNativeManifest(runtime, platform, arch) {
    const { root, file, manifest } = await readNative(runtime, platform, arch);
    for (const name of Object.keys(manifest.hashes)) manifest.hashes[name] = await fileDigest(runtimeFile(root, name));
    await writeFile(file, JSON.stringify(manifest, null, 2) + '\n');
}

export async function verifyNativeManifest(runtime, platform, arch) {
    const { root, manifest } = await readNative(runtime, platform, arch);
    for (const [name, expected] of Object.entries(manifest.hashes)) {
        assert.equal(await fileDigest(runtimeFile(root, name)), expected, `Native helper checksum mismatch: ${name}`);
    }
}
