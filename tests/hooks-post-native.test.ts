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
import { roots, services, openService, fixture, effect, signal, nativeTimeout } from './support/hook-fixture.js';
it('keeps post failure observational and does not repeat the underlying side effect', async () => {
    const f = await fixture('invalid', ['PostToolUse']), execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'done', sideEffectState: 'applied' as const }));
    expect((await f.service.around(effect(), signal(), undefined, execute)).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
    await f.service.stop();
    expect(await readFile(join(f.journal, (await readdir(f.journal))[0]!), 'utf8')).toContain('diagnostic');
}, nativeTimeout(1, 10000));
it('runs a post hook snapshot nested inside its readonly workspace', async () => {
    const f = await fixture('{}', ['PostToolUse']);
    const secret = join(f.base, 'parent-secret.txt');
    await writeFile(secret, 'outside workspace');
    await writeFile(join(f.base, 'source/hook.cjs'), `
        const fs = require('node:fs');
        let data = '';
        process.stdin.on('data', chunk => data += chunk);
        process.stdin.on('end', () => {
            const denied = (action) => { try { action(); return false } catch { return true } };
            if (JSON.parse(data).hook_event_name !== 'PostToolUse'
                || fs.readFileSync('a.txt', 'utf8') !== 'hello'
                || !denied(() => fs.writeFileSync('a.txt', 'changed'))
                || !denied(() => fs.writeFileSync(__dirname + '/forbidden.txt', 'changed'))
                || !denied(() => fs.readFileSync(${JSON.stringify(secret)}))) process.exit(3);
            process.stdout.write('{}');
        });
    `);
    const snapshot = await loadHookDefinitions(f.file, join(f.root, 'nested', 'installed'));
    const service = openService(f.root, f.journal, { conversationId: 'c', runId: 'r' }, snapshot, { ...snapshot, enabled: true });
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'once', sideEffectState: 'applied' as const }));
    expect(await service.around(effect(), signal(), undefined, execute)).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' });
    await service.stop();
    expect(execute).toHaveBeenCalledTimes(1);
    const receipts = await Promise.all((await readdir(f.journal)).map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
    expect(receipts).toEqual([expect.objectContaining({ event: 'PostToolUse', status: 'continue' })]);
    expect(await readFile(join(f.root, 'a.txt'), 'utf8')).toBe('hello');
    expect(await readFile(secret, 'utf8')).toBe('outside workspace');
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
        expect(receipts, JSON.stringify(receipts)).toContainEqual(expect.objectContaining({ event: 'PostToolUseFailure', status: 'continue' }));
    } finally {
        input.mockRestore();
        await host.close();
    }
}, nativeTimeout(1, 30000));
