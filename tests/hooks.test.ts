import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookService, loadHookDefinitions, checkHookDefinitions, hookArgv, hookMatches } from '../packages/server/src/hooks/index.js';
import { createLocalHost } from '../packages/server/src/index.js';
import { runShell } from '../packages/adapters/src/tools/shell.js';
import * as adapters from '@hunterzhu/pulse-adapters';
import { ShellProcesses } from '../packages/server/src/shell-processes.js';
import type { EffectRecord } from '@hunterzhu/pulse-runtime';
const roots: string[] = [];
const services: HookService[] = [];
const openService = (...args: ConstructorParameters<typeof HookService>) => { const service = new HookService(...args); services.push(service); return service };
afterEach(async () => {
    const pending = services.splice(0);
    try { for (const service of pending) { await service.stop(); await service.dispose(); } }
    finally { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true }))); }
});
async function fixture(output = '{}', events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
    const base = await mkdtemp(join(tmpdir(), 'pulse-hooks-'));
    roots.push(base);
    const root = join(base, 'workspace'), definitions = join(base, 'source');
    await mkdir(root);
    await mkdir(definitions);
    await writeFile(join(root, 'a.txt'), 'hello');
    await writeFile(join(definitions, 'hook.cjs'), `let data='';process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>{JSON.parse(data);process.stdout.write(${JSON.stringify(output)})})`);
    const file = join(definitions, 'hooks.json');
    await writeFile(file, JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, [{ matcher: event.includes('Tool') ? 'Read' : '', hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'], timeout: 1 }] }]])) }));
    const snapshot = await loadHookDefinitions(file, join(base, 'installed')), trusted = { ...snapshot, enabled: true }, journal = join(base, 'receipts'), service = openService(root, journal, { conversationId: 'c', runId: 'r' }, snapshot, trusted);
    return { base, root, file, snapshot, trusted, journal, service };
}
const effect = (attemptId = 'a1') => ({ id: 'e1', kind: 'tool', attemptId, attemptNo: 1, agentId: 'agent', ownerLaneId: 'lane', toolCallId: 'tc', input: { name: 'fs.read', arguments: { path: 'a.txt', token: 'secret' } } }) as EffectRecord;
const signal = () => new AbortController().signal;
// Budget only whole native cases for measured Windows sandbox ACL setup.
const nativeTimeout = (launches: number, local = 30000) => process.platform === 'win32' ? launches * 240000 : local;
it('supports bounded common matching and literal argv, rejecting shell execution and unsupported regex', () => {
    expect(hookArgv('node "a b.js"')).toEqual(['node', 'a b.js']);
    expect(hookMatches('Bash|Write', 'shell.exec')).toBe(true);
    expect(hookMatches('code.*', 'code.definition')).toBe(true);
    for (const command of ['sh -c "exit 0"', 'node a.js && rm x', 'node $(x)'])
        expect(() => hookArgv(command)).toThrow();
    expect(() => hookMatches('(a+)+', 'x')).toThrow();
});
it('freezes script assets and rejects any changed definition or asset', async () => {
    const f = await fixture();
    expect(await checkHookDefinitions(f.snapshot)).toHaveLength(5);
    await writeFile(join(f.snapshot.directory, 'assets/hook.cjs'), 'changed');
    await expect(checkHookDefinitions(f.snapshot)).rejects.toThrow('HOOK_ASSET_CHANGED');
});
it('orders events, preserves receipts and never replays completed/unknown hooks on another attempt', async () => {
    const f = await fixture(), execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'ok' }));
    await f.service.sessionStart(signal());
    await f.service.around(effect(), signal(), undefined, execute);
    await f.service.stop();
    const files = await readdir(f.journal), receipts = await Promise.all(files.map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
    expect(receipts.map(r => r.event).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
    const pre = receipts.find(r => r.event === 'PreToolUse');
    expect(pre).toMatchObject({ effectId: 'e1', attemptId: 'a1', definitionHash: f.snapshot.hash, status: 'continue' });
    const path = join(f.journal, files[receipts.indexOf(pre)]!);
    await writeFile(path, JSON.stringify({ ...pre, status: 'running' }));
    const second = openService(f.root, f.journal, { conversationId: 'c', runId: 'r' }, f.snapshot, f.trusted);
    const result = await second.around(effect('a2'), signal(), undefined, execute);
    expect(result.error?.code).toBe('HOOK_PRE_DENIED');
    expect(execute).toHaveBeenCalledTimes(1);
}, nativeTimeout(4, 10000));
it.each(['{"continue":false}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{}}}', 'not-json'])('blocks invalid or denied pre output %s', async (output) => {
    const f = await fixture(output, ['PreToolUse']), execute = vi.fn();
    expect((await f.service.around(effect(), signal(), undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect(execute).not.toHaveBeenCalled();
}, nativeTimeout(1, 10000));
it('keeps post failure observational and does not repeat the underlying side effect', async () => {
    const f = await fixture('invalid', ['PostToolUse']), execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'done', sideEffectState: 'applied' as const }));
    expect((await f.service.around(effect(), signal(), undefined, execute)).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
    await f.service.stop();
    expect(await readFile(join(f.journal, (await readdir(f.journal))[0]!), 'utf8')).toContain('diagnostic');
}, nativeTimeout(1, 10000));
it('executes the real Host effect boundary and Stop lifecycle using mock models only', async () => {
    const f = await fixture(), dataDir = join(f.base, 'data'), host = createLocalHost({ cwd: f.root, dataDir, hooks: f.trusted, taskController: false, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.read', input: { path: 'a.txt' } }], mockAfterToolResponse: 'done' });
    await host.init();
    try {
        const c = await host.createConversation({ cwd: f.root });
        const run = await host.sendMessage(c.id, { text: 'Read a.txt' });
        expect((await run.outcome()).status).toBe('succeeded');
        const journal = join(dataDir, 'conversations', c.id, 'runs', run.id, 'hooks');
        const receipts = await Promise.all((await readdir(journal)).map(p => readFile(join(journal, p), 'utf8').then(JSON.parse)));
        expect(receipts.map(r => r.event).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
        expect(receipts.every(r => r.runId === run.id && r.definitionHash === f.snapshot.hash)).toBe(true);
    }
    finally {
        await host.close();
    }
}, nativeTimeout(4, 30000));
it('pre timeout remains unknown across attempts and never executes the tool', async () => {
    const f = await fixture('{}', ['PreToolUse']);
    await writeFile(join(f.base, 'source/hook.cjs'), 'setTimeout(()=>{},10000)');
    const raw = JSON.parse(await readFile(f.file,'utf8')); raw.hooks.PreToolUse[0].hooks[0].timeout = 0.2;
    await writeFile(f.file,JSON.stringify(raw));
    const snapshot=await loadHookDefinitions(f.file,join(f.base,'timeouts'));
    const service=openService(f.root,f.journal,{conversationId:'c',runId:'r'},snapshot,{...snapshot,enabled:true});
    const execute=vi.fn();
    expect((await service.around(effect(),signal(),undefined,execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect((await service.around(effect('a2'),signal(),undefined,execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect(execute).not.toHaveBeenCalled();
    const receipts=await Promise.all((await readdir(f.journal)).map(p=>readFile(join(f.journal,p),'utf8').then(JSON.parse)));
    expect(receipts.some(r=>r.status==='unknown')).toBe(true);
    await service.dispose();
}, nativeTimeout(1, 30000));
it('slow post observers cannot delay applied tool settlement and dispose drains owned scripts', async () => {
    const f=await fixture('{}',['PostToolUse']);
    await writeFile(join(f.base,'source/hook.cjs'),'process.stdin.resume();setTimeout(()=>process.stdout.write("{}"),5000)');
    const snapshot=await loadHookDefinitions(f.file,join(f.base,'slow'));
    const service=openService(f.root,f.journal,{conversationId:'c',runId:'r'},snapshot,{...snapshot,enabled:true});
    const started=Date.now(), execute=vi.fn(async()=>({status:'succeeded' as const,value:'once',sideEffectState:'applied' as const}));
    expect(await service.around(effect(),signal(),undefined,execute)).toMatchObject({status:'succeeded',sideEffectState:'applied'});
    expect(Date.now()-started).toBeLessThan(500);
    expect(execute).toHaveBeenCalledTimes(1);
    await service.dispose();
}, nativeTimeout(1, 30000));
it('revocation blocks new pre hooks while legacy runs without a snapshot remain independent', async()=>{
    const f=await fixture('{}',['PreToolUse']), execute=vi.fn(async()=>({status:'succeeded' as const,value:'ok'}));
    const revoked=openService(f.root,f.journal,{conversationId:'c',runId:'r'},f.snapshot,{...f.trusted,enabled:false});
    expect((await revoked.around(effect(),signal(),undefined,execute)).status).toBe('failed');
    const legacy=openService(f.root,f.journal,{conversationId:'c',runId:'legacy'},undefined,f.trusted);
    expect((await legacy.around(effect(),signal(),undefined,execute)).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
});
it('omits raw shell.stdin data from the hook and does not pass injected host markers', async () => {
    const previous = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, KUBECONFIG: process.env.KUBECONFIG };
    process.env.AWS_ACCESS_KEY_ID = 'fake-aws-marker';
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent-marker';
    process.env.KUBECONFIG = '/tmp/fake-kube-marker';
    try {
        const f = await fixture('{}', ['PreToolUse']);
        const processId = 'ab'.repeat(32);
        const bytes = Buffer.byteLength('fake-private-keystrokes');
        await writeFile(join(f.base, 'source/hook.cjs'), `let data='';process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>{const payload=JSON.parse(data);const input=payload.tool_input||{};const leaked=data.includes('fake-private-keystrokes');const clean=process.env.AWS_ACCESS_KEY_ID!=='fake-aws-marker'&&process.env.SSH_AUTH_SOCK!=='/tmp/fake-agent-marker'&&process.env.KUBECONFIG!=='/tmp/fake-kube-marker';const ok=!leaked&&clean&&input.data==='[redacted]'&&input.bytes===${bytes}&&input.processId==='${processId}';process.stdout.write(ok?'{}':JSON.stringify({continue:false}))})`);
        const raw = JSON.parse(await readFile(f.file, 'utf8'));
        raw.hooks.PreToolUse[0].matcher = 'shell.stdin';
        await writeFile(f.file, JSON.stringify(raw));
        const snapshot = await loadHookDefinitions(f.file, join(f.base, 'redacted'));
        const service = openService(f.root, f.journal, { conversationId: 'c', runId: 'r' }, snapshot, { ...snapshot, enabled: true });
        const execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'ran' }));
        const result = await service.around({ ...effect(), input: { name: 'shell.stdin', arguments: { processId, data: 'fake-private-keystrokes' } } }, signal(), undefined, execute);
        expect(result.status).toBe('succeeded');
        expect(execute).toHaveBeenCalledTimes(1);
    } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}, nativeTimeout(1, 30000));
it('an early stdin close is unknown for pre, skips the tool, and stays closed on another attempt', async () => {
    const f = await fixture('{}', ['PreToolUse']);
    await writeFile(join(f.base, 'source/hook.cjs'), `require('node:fs').closeSync(0);process.stdout.write('{}')`);
    const raw = JSON.parse(await readFile(f.file, 'utf8'));
    raw.hooks.PreToolUse[0].hooks[0].timeout = 5;
    await writeFile(f.file, JSON.stringify(raw));
    const snapshot = await loadHookDefinitions(f.file, join(f.base, 'closed'));
    const service = openService(f.root, f.journal, { conversationId: 'c', runId: 'r' }, snapshot, { ...snapshot, enabled: true });
    // Pipe capacity varies by OS: closing fd 0 does not guarantee EPIPE after
    // a small write. Inject the adapter's definite delivery failure here.
    const shell = vi.spyOn(adapters, 'runShell').mockRejectedValueOnce(Object.assign(new Error('SHELL_STDIN_DELIVERY_UNKNOWN'), { code: 'SHELL_STDIN_DELIVERY_UNKNOWN' }));
    const padding = 'p'.repeat(4000);
    const execute = vi.fn();
    const target = { ...effect(), input: { name: 'fs.read', arguments: { path: 'a.txt', p1: padding, p2: padding, p3: padding, p4: padding, p5: padding, p6: padding, p7: padding, p8: padding } } } as EffectRecord;
    expect((await service.around(target, signal(), undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect((await service.around({ ...target, attemptId: 'a2' }, signal(), undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect(execute).not.toHaveBeenCalled();
    expect(shell).toHaveBeenCalledTimes(1);
    const receipts = await Promise.all((await readdir(f.journal)).map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
    expect(receipts).toContainEqual(expect.objectContaining({ event: 'PreToolUse', status: 'unknown', error: 'HOOK_OUTCOME_UNKNOWN' }));
}, 30000);
it('an early post stdin close stays diagnostic and leaves the applied tool result', async () => {
    const f = await fixture('{}', ['PostToolUse']);
    await writeFile(join(f.base, 'source/hook.cjs'), `require('node:fs').closeSync(0);process.stdout.write('{}')`);
    const raw = JSON.parse(await readFile(f.file, 'utf8'));
    raw.hooks.PostToolUse[0].hooks[0].timeout = 5;
    await writeFile(f.file, JSON.stringify(raw));
    const snapshot = await loadHookDefinitions(f.file, join(f.base, 'post-closed'));
    const service = openService(f.root, f.journal, { conversationId: 'c', runId: 'r' }, snapshot, { ...snapshot, enabled: true });
    const shell = vi.spyOn(adapters, 'runShell').mockRejectedValueOnce(Object.assign(new Error('SHELL_STDIN_DELIVERY_UNKNOWN'), { code: 'SHELL_STDIN_DELIVERY_UNKNOWN' }));
    const marker = join(f.root, 'once.txt');
    const padding = 'p'.repeat(4000);
    const execute = vi.fn(async () => { await writeFile(marker, 'once'); return { status: 'succeeded' as const, value: 'once', sideEffectState: 'applied' as const }; });
    const target = { ...effect(), input: { name: 'fs.read', arguments: { path: 'a.txt', p1: padding, p2: padding, p3: padding, p4: padding, p5: padding, p6: padding, p7: padding, p8: padding } } } as EffectRecord;
    expect(await service.around(target, signal(), undefined, execute)).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' });
    expect(execute).toHaveBeenCalledTimes(1);
    await service.stop();
    expect(shell).toHaveBeenCalledTimes(1);
    expect(await readFile(marker, 'utf8')).toBe('once');
    const receipts = await Promise.all((await readdir(f.journal)).map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
    expect(receipts).toEqual([expect.objectContaining({ event: 'PostToolUse', status: 'diagnostic', error: 'HOOK_OUTCOME_UNKNOWN' })]);
}, 30000);
it('observes shell.stdin unknown at the host boundary without treating it as a generic failure', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pulse-hook-unknown-'));
    roots.push(root);
    const source = join(root, 'source');
    await mkdir(source);
    const processId = 'cd'.repeat(32);
    const bytes = Buffer.byteLength('fake-private-keystrokes');
    await writeFile(join(source, 'hook.cjs'), `let data='';process.stdin.on('data',s=>data+=s);process.stdin.on('end',()=>{const payload=JSON.parse(data);const response=payload.tool_response||{};const input=payload.tool_input||{};const leaked=data.includes('fake-private-keystrokes');const ok=!leaked&&input.data==='[redacted]'&&input.bytes===${bytes}&&response.error==='SHELL_STDIN_DELIVERY_UNKNOWN'&&response.executionState==='remote_unknown'&&response.sideEffectState==='unknown'&&response.status!=='failed'&&!data.includes('TOOL_EXECUTION_FAILED');process.stdout.write(ok?'{}':'no')})`);
    const file = join(source, 'hooks.json');
    await writeFile(file, JSON.stringify({ hooks: { PostToolUseFailure: [{ matcher: '.*', hooks: [{ type: 'command', command: [process.execPath, 'hook.cjs'], timeout: 5 }] }] } }));
    const snapshot = await loadHookDefinitions(file, join(root, 'installed'));
    const input = vi.spyOn(ShellProcesses.prototype, 'input').mockResolvedValue({ processId, effectId: 'effect', agentId: 'agent', laneId: 'lane', digest: 'digest', bytes: 24, status: 'unknown' });
    const host = createLocalHost({ cwd: root, dataDir: join(root, 'data'), hooks: { ...snapshot, enabled: true }, taskController: false, approvalMode: 'auto', mockToolCalls: [{ name: 'shell.stdin', input: { processId, data: 'fake-private-keystrokes' } }] });
    try {
        const conversation = await host.createConversation();
        const run = await host.sendMessage(conversation.id, { text: 'Send input' });
        void (async () => { for await (const event of run.events) void event; })();
        const deadline = Date.now() + (process.platform === 'win32' ? 240000 : 15000);
        const journal = join(root, 'data', 'conversations', conversation.id, 'runs', run.id, 'hooks');
        let settled: { executionState?: string; sideEffectState?: string; state?: string } | undefined;
        let receipts: Array<{ event?: string; status?: string }> = [];
        while (Date.now() < deadline) {
            const runtime = (host as unknown as { active: Map<string, { runtime: { state: { effects: Map<string, { kind: string; executionState?: string; sideEffectState?: string; state?: string }> } } }> }).active.get(run.id)?.runtime;
            settled = [...(runtime?.state.effects.values() ?? [])].find(item => item.kind === 'tool');
            receipts = await Promise.all((await readdir(journal).catch(() => [] as string[])).map(p => readFile(join(journal, p), 'utf8').then(JSON.parse)));
            if (settled?.executionState === 'remote_unknown' && receipts.some(item => item.status === 'continue' || item.status === 'diagnostic')) break;
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        expect(settled).toMatchObject({ executionState: 'remote_unknown', sideEffectState: 'unknown', state: 'reconcile_required' });
        expect(receipts).toContainEqual(expect.objectContaining({ event: 'PostToolUseFailure', status: 'continue' }));
    } finally {
        input.mockRestore();
        await host.close();
    }
}, nativeTimeout(1, 30000));
it('a sealed hook child keeps sandbox runtime settings and drops injected host markers', async () => {
    const previous = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, KUBECONFIG: process.env.KUBECONFIG };
    process.env.AWS_ACCESS_KEY_ID = 'fake-aws-marker';
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent-marker';
    process.env.KUBECONFIG = '/tmp/fake-kube-marker';
    const root = await mkdtemp(join(tmpdir(), 'pulse-hook-sealed-'));
    roots.push(root);
    try {
        const result = await runShell(process.execPath, ['-e', `process.stdout.write(JSON.stringify({aws:process.env.AWS_ACCESS_KEY_ID??null,ssh:process.env.SSH_AUTH_SOCK??null,kube:process.env.KUBECONFIG??null,sandbox:process.env.SANDBOX_RUNTIME??null,home:process.env.HOME??''}))`], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C' }, readOnlyWorkspace: true, isolatedHome: true, stdioTarget: true, allowedDomains: [], timeoutMs: 20000, stdinData: '{}', sealedCallerEnv: true });
        expect(result.code).toBe(0);
        const child = JSON.parse(result.stdout) as { aws: string | null; ssh: string | null; kube: string | null; sandbox: string | null; home: string };
        expect(child).toMatchObject({ aws: null, ssh: null, kube: null, sandbox: '1' });
        expect(child.home).toContain('pulse-shell-');
        expect(child.home).not.toBe(process.env.HOME);
    } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}, nativeTimeout(1, 30000));
