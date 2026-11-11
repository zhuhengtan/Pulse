/** Real Git/manager and supervisor child with native signals. HTTP/model replies are scripted. */
import { execFile, spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
it.runIf(process.platform !== 'win32').each(['candidate', 'integration'])('native SIGTERM during %s checks stops before real Git apply', async phase => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pulse-selfhost-cancel-')))
  const project = join(root, 'project'), data = join(root, 'data'), home = join(root, 'home'), hooks = join(root, 'hooks'), out = join(root, 'out')
  for (const dir of [project, data, home, hooks]) await mkdir(dir)
  const config = join(root, 'gitconfig'); await writeFile(config, '')
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, PULSE_HOME: home, PULSE_DATA_DIR: data,
    PULSE_CONFIG: join(home, 'config.json'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: config, GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks,
    GIT_CONFIG_KEY_1: 'commit.gpgSign', GIT_CONFIG_VALUE_1: 'false', GIT_CONFIG_KEY_2: 'tag.gpgSign', GIT_CONFIG_VALUE_2: 'false' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete env[key]
  const git = async (...args: string[]) => (await execute('git', args, { cwd: project, env, encoding: 'utf8' })).stdout
  let child: ReturnType<typeof spawn> | undefined
  try {
    // Transpile the actual manager and its two local dependencies into a private stable engine.
    const server = join(root, 'engine/node_modules/@hunterzhu/pulse-server')
    await mkdir(join(server, 'dist/h5'), { recursive: true })
    await writeFile(join(server, 'package.json'), '{"type":"module"}')
    for (const name of ['h5/workspaces', 'h5/dependencies', 'atomic-file']) {
      const text = await readFile(resolve('packages/server/src', name + '.ts'), 'utf8')
      await writeFile(join(server, 'dist', name + '.js'), ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)
    }
    const entry = join(root, 'engine/entry.mjs'); await writeFile(entry, '// stable entry; H5 never executes this CLI')
    const managerFile = join(server, 'dist/h5/workspaces.js')
    await git('init', '--quiet'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@localhost')
    await writeFile(join(project, 'user.txt'), 'base\n')
    const check = join(project, 'check.mjs'), signaled = join(root, 'signaled')
    await writeFile(check, `import{existsSync,writeFileSync}from'node:fs';
if(!existsSync('result.txt'))process.exit(23);
const integration=process.cwd().includes('integrations');
if(${JSON.stringify(phase)}==='integration'?integration:!integration&&process.cwd()!==${JSON.stringify(project)}){
 process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(signaled)},'sent');process.kill(process.ppid,'SIGTERM');setTimeout(()=>process.exit(0),40);
}`)
    await git('add', '.'); await git('commit', '--quiet', '-m', 'baseline')
    const head = await git('rev-parse', 'HEAD')
    await writeFile(join(project, 'user.txt'), 'staged\n'); await git('add', 'user.txt')
    await writeFile(join(project, 'user.txt'), 'unstaged\n'); await writeFile(join(project, 'untracked.txt'), 'keep\n')
    const index = await git('diff', '--cached', '--binary')
    const task = join(root, 'task.txt'), checks = join(root, 'checks.json')
    await writeFile(task, 'Create result.txt.'); await writeFile(checks, JSON.stringify([[process.execPath, 'check.mjs']]))
    const driver = join(root, 'driver.mjs')
    await writeFile(driver, `import{mkdir,writeFile}from'node:fs/promises';import{join}from'node:path';
import{H5WorkspaceManager}from ${JSON.stringify(pathToFileURL(managerFile).href)};
import{main,installSignalHandlers}from ${JSON.stringify(pathToFileURL(resolve('scripts/self-host.mjs')).href)};
const cwd=${JSON.stringify(project)},data=${JSON.stringify(data)};
const manager=new H5WorkspaceManager(data);const workspace=await manager.prepare('conv-fixture','project-fixture',cwd,{isolated:true,externalValidation:true});await writeFile(join(workspace.cwd,'result.txt'),'hello');await manager.close();
const runs=join(data,'conversations/conv-fixture/runs/run-fixture');await mkdir(runs,{recursive:true});await writeFile(join(runs,'task-outcome.json'),JSON.stringify({status:'accepted'}));
const http={request:async url=>{if(url==='/api/session/local')return{ok:true};if(url==='/api/session')return{capabilities:{selfHostExternalValidation:1,selfHostInternalDataBoundary:1}};if(url==='/api/projects')return[{id:'project-fixture',cwd}];if(url==='/api/conversations')return{id:'conv-fixture'};if(url.endsWith('/messages'))return{runId:'run-fixture'};if(url.endsWith('/state'))return{state:'succeeded'};return{ok:true}}};
const cleanup=installSignalHandlers();try{process.exitCode=await main(${JSON.stringify(['--transport','h5','--cwd',project,'--data-dir',data,'--cli-entry',entry,'--task-file',task,'--checks-file',checks,'--freeze-file',check,'--output',out,'--max-attempts','1','--timeout-ms','10000'])},{http,log:()=>{}})}finally{cleanup()}`)
    child = spawn(process.execPath, [driver], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stderr = ''; child.stderr!.on('data', data => { stderr += data })
    const result = await new Promise<{code:number|null,signal:string|null}>((yes, no) => {
      const timer = setTimeout(() => { child!.kill('SIGKILL'); no(new Error('Fixture timed out: ' + stderr)) }, 20_000)
      child!.once('error', error => { clearTimeout(timer); no(error) }); child!.once('close', (code, signal) => { clearTimeout(timer); yes({ code, signal }) })
    })
    expect(result.code, stderr).toBe(5); expect(await readFile(signaled, 'utf8')).toBe('sent')
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'))
    expect(report).toMatchObject({ ok: false, status: 'timeout', interruptedBy: 'SIGTERM' })
    expect(report.delivery.merge).not.toBe('merged')
    await expect(readFile(join(project, 'result.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await git('rev-parse','HEAD')).toBe(head);expect(await git('diff','--cached','--binary')).toBe(index)
    expect(await readFile(join(project,'user.txt'),'utf8')).toBe('unstaged\n');expect(await readFile(join(project,'untracked.txt'),'utf8')).toBe('keep\n')
  } finally { if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
}, 30_000)
