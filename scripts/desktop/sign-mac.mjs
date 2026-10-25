import { createRequire } from 'node:module';
import { join } from 'node:path';
import { readRuntimeManifest, writeRuntimeManifest } from '../../packages/desktop/src/runtime-manifest.mjs';
import { refreshNativeManifest } from './native-manifest.mjs';

// Signing nested Node/Chromium executables changes the bytes checked at install.
// Refresh their manifest before sealing the outer app a final time.
export default async function signMac(options) {
    const desktopRequire = createRequire(new URL('../../packages/desktop/package.json', import.meta.url));
    const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
    const { signAsync } = createRequire(builderRequire.resolve('app-builder-lib'))('@electron/osx-sign');
    await signAsync(options);
    const runtime = join(options.app, 'Contents/Resources/runtime');
    const previous = await readRuntimeManifest(runtime, 'darwin', 'arm64');
    await refreshNativeManifest(runtime, 'darwin', 'arm64');
    await writeRuntimeManifest(runtime, previous.version, previous.platform, previous.arch,
        previous.browserExecutable ? { browserExecutable: previous.browserExecutable } : {});
    await signAsync({ ...options, ignore: file => file !== options.app });
}
