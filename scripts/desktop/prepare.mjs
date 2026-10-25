import { createRequire } from 'node:module';
import { writeRuntimeManifest } from '../../packages/desktop/src/runtime-manifest.mjs';
import { optimizeRuntime } from './optimize-runtime.mjs';
import { verifyRuntimePlatform } from './verify-runtime-platform.mjs';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, readFile, writeFile, copyFile, chmod, cp, access } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const run = (file, args, env = process.env) => { const result = spawnSync(file, args, { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' && file === 'pnpm' }); if (result.status !== 0)
    process.exit(result.status ?? 1); };
run('pnpm', ['web:build']);
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b', '--pretty', 'false']);
run(process.execPath, ['scripts/cli/pack.mjs']);
const version = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8')).version;
const destination = join(root, 'artifacts/desktop-runtime');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
run('tar', ['-xzf', join(root, `artifacts/cli/pulse-${version}.tar.gz`), '-C', destination]);
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node';
await copyFile(process.execPath, join(destination, 'pulse', nodeName));
if (process.platform !== 'win32')
    await chmod(join(destination, 'pulse', nodeName), 0o755);
const bundle = join(destination, 'pulse');
const optimization = await optimizeRuntime(bundle);
await copyFile(join(dirname(process.execPath), '../LICENSE'), join(bundle, 'LICENSES/Node.LICENSE')).catch(() => {});
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const pw = createRequire(require.resolve('@playwright/mcp'));
const executable = pw('playwright').chromium.executablePath();
let browserExecutable;
if (process.env.PULSE_DESKTOP_BUNDLE_BROWSER !== '0') {
    let cached = dirname(executable);
    while (dirname(cached) !== cached && !/^chromium-\d+$/.test(basename(cached))) cached = dirname(cached);
    if (/^chromium-\d+$/.test(basename(cached)) && await access(executable).then(() => true, () => false)) {
        const target = join(bundle, 'browsers', basename(cached));
        await cp(cached, target, { recursive: true, dereference: false, verbatimSymlinks: true });
        browserExecutable = relative(bundle, join(target, relative(cached, executable))).split(sep).join('/');
    } else {
        const browsers = join(bundle, 'browsers'), cli = join(dirname(pw.resolve('playwright/package.json')), 'cli.js');
        const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers };
        run(process.execPath, [cli, 'install', 'chromium'], env);
        const result = spawnSync(process.execPath, ['-e', `console.log(require(${JSON.stringify(pw.resolve('playwright/package.json').replace(/package\.json$/, 'index.js'))}).chromium.executablePath())`], { env, encoding: 'utf8' });
        if (result.status !== 0) throw new Error('BROWSER_RUNTIME_PREPARE_FAILED');
        browserExecutable = relative(bundle, result.stdout.trim()).split(sep).join('/');
    }
}
optimization.nativePayloads = await verifyRuntimePlatform(bundle);
await writeFile(join(destination, 'optimization.json'), JSON.stringify(optimization, null, 2) + '\n');
await writeRuntimeManifest(bundle, version, process.platform, process.arch, browserExecutable ? { browserExecutable } : {});
console.log('Desktop runtime prepared; execute pnpm desktop:app:pack or pnpm desktop:app:dist.');
