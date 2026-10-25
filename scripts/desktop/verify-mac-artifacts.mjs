import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { readRuntimeManifest, verifyRuntime } from '../../packages/desktop/src/runtime-manifest.mjs';
import { verifyNativeManifest } from './native-manifest.mjs';
import { verifyRuntimePlatform } from './verify-runtime-platform.mjs';

assert.equal(process.platform, 'darwin', 'Verify Mac artifacts on macOS');
const execute = promisify(execFile);
const artifacts = process.argv[2] ?? fileURLToPath(new URL('../../artifacts/desktop/', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'pulse-mac-artifact-verify-'));
const results = [];
async function verify(app, format) {
    await execute('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const runtime = join(app, 'Contents/Resources/runtime');
    const manifest = await readRuntimeManifest(runtime, 'darwin', 'arm64');
    await verifyRuntime(runtime, manifest, true);
    await verifyNativeManifest(runtime, 'darwin', 'arm64');
    await verifyRuntimePlatform(runtime, 'darwin');
    const info = join(app, 'Contents/Info.plist');
    const id = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info]);
    assert.equal(id.stdout.trim(), 'com.hunterzhu.pulse.desktop');
    const version = await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', info]);
    assert.equal(version.stdout.trim(), JSON.parse(await readFile(new URL('../../packages/desktop/package.json', import.meta.url), 'utf8')).version);
    const assessment = await execute('spctl', ['--assess', '--type', 'execute', '--verbose=4', app])
        .then(value => ({ accepted: true, detail: value.stderr.trim() }))
        .catch(error => {
            if (typeof error.code !== 'number') throw error;
            return { accepted: false, detail: String(error.stderr).trim() };
        });
    // Ad-hoc signature integrity is separate from Developer ID/notarization trust.
    results.push({ format, version: manifest.version, signatureIntegrity: true, runtimeIntegrity: true, gatekeeper: assessment });
}
try {
    const mount = join(temporary, 'dmg');
    await mkdir(mount);
    await execute('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, join(artifacts, 'pulse-macos-arm64.dmg')]);
    try { await verify(join(mount, 'Pulse.app'), 'dmg'); }
    finally { await execute('hdiutil', ['detach', mount]); }
    const extracted = join(temporary, 'zip');
    await mkdir(extracted);
    await execute('ditto', ['-x', '-k', join(artifacts, 'pulse-macos-arm64.zip'), extracted]);
    await verify(join(extracted, 'Pulse.app'), 'zip');
    console.log(JSON.stringify({ macArtifactsVerified: results }));
} finally {
    await rm(temporary, { recursive: true, force: true });
}
