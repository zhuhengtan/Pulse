import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const desktopRequire = createRequire(join(repo, 'packages/desktop/package.json'));
const builderRequire = createRequire(desktopRequire.resolve('electron-builder'));
const tools = builderRequire('app-builder-lib/out/toolsets/windows.js');
const compiler = await tools.getMakeNsisPath(undefined);
const plugins = await tools.getNsisPluginsPath(undefined);
const root = await mkdtemp(join(tmpdir(), 'Pulse installer check '));
let child;
function run(executable, args, expected = 0, env = process.env) {
    const result = spawnSync(executable, args, { env, encoding: 'utf8', timeout: 30000 });
    if (result.error) throw result.error;
    assert.equal(result.status, expected, `${executable}: ${result.stdout ?? ''}\n${result.stderr ?? ''}`);
}
try {
    const original = await readFile(join(repo, 'packages/desktop/build/installer.nsh'), 'utf8');
    const name = 'Pulse installer fixture.exe';
    for (const [id, reply, expected] of [['absent', 603, 0], ['present', 0, 2], ['enumeration-error', 608, 3], ['native', undefined, 0]]) {
        const include = join(root, `${id}.nsh`), source = join(root, `${id}.nsi`), executable = join(root, `${id}.exe`);
        // Fault injection replaces only the plugin reply. Execute the real
        // shipping macro's branches, silent defaults and stack restoration.
        await writeFile(include, reply === undefined ? original : original.replace('nsProcess::_FindProcess /NOUNLOAD "${APP_EXECUTABLE_FILENAME}"', `Push ${reply}`));
        await writeFile(source, `Unicode true\n!include "LogicLib.nsh"\n!addplugindir /x86-unicode "${join(plugins, 'x86-unicode')}"\n!define APP_EXECUTABLE_FILENAME "${name}"\n!include "${include}"\nOutFile "${executable}"\nRequestExecutionLevel user\nSilentInstall silent\nSection\nPush "stack-sentinel"\nStrCpy $R0 "register-sentinel"\n!insertmacro customCheckAppRunning\n!insertmacro customCheckAppRunning\nStrCmp $R0 "register-sentinel" +3\nSetErrorLevel 98\nQuit\nPop $R1\nStrCmp $R1 "stack-sentinel" +3\nSetErrorLevel 99\nQuit\nSetErrorLevel 0\nSectionEnd\n`);
        run(compiler.path, ['-V2', source], 0, { ...process.env, ...compiler.env });
        if (process.platform === 'win32') {
            run(executable, ['/S'], expected);
            if (id === 'native') {
                const fixture = join(root, name);
                await cp(process.execPath, fixture);
                child = spawn(fixture, ['-e', 'console.log("ready");setInterval(()=>{},1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
                let timer;
                try {
                    await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error('Fixture exited before readiness'); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Fixture readiness timeout')), 10000); })]);
                } finally { clearTimeout(timer); }
                run(executable, ['/S'], 2);
                const exited = once(child, 'exit'); child.kill(); await exited; child = undefined;
                run(executable, ['/S']);
            }
        }
        console.log(`Installer process check ${id}: compiled${process.platform === 'win32' ? ' and executed' : ' (Windows execution pending)'}`);
    }
} finally {
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
