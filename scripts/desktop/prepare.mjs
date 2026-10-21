import { spawnSync } from 'node:child_process';
import { mkdir, rm, readFile, copyFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
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
console.log('Desktop runtime prepared; execute pnpm desktop:app:pack or pnpm desktop:app:dist.');
