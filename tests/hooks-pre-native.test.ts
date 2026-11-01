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
it.each(['{"continue":false}', '{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{}}}', 'not-json'])('blocks invalid or denied pre output %s', async (output) => {
    const f = await fixture(output, ['PreToolUse']), execute = vi.fn();
    expect((await f.service.around(effect(), signal(), undefined, execute)).error?.code).toBe('HOOK_PRE_DENIED');
    expect(execute).not.toHaveBeenCalled();
}, nativeTimeout(1, 10000));
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
    expect(receipts.some(r=>r.status==='unknown'), JSON.stringify(receipts)).toBe(true);
    await service.dispose();
}, nativeTimeout(1, 30000));
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
        const receipts = await Promise.all((await readdir(f.journal)).map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
        expect(result.status, JSON.stringify({ result, receipts })).toBe('succeeded');
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
