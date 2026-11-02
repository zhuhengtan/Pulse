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
it('revocation blocks new pre hooks while legacy runs without a snapshot remain independent', async()=>{
    const f=await fixture('{}',['PreToolUse']), execute=vi.fn(async()=>({status:'succeeded' as const,value:'ok'}));
    const revoked=openService(f.root,f.journal,{conversationId:'c',runId:'r'},f.snapshot,{...f.trusted,enabled:false});
    expect((await revoked.around(effect(),signal(),undefined,execute)).status).toBe('failed');
    const legacy=openService(f.root,f.journal,{conversationId:'c',runId:'legacy'},undefined,f.trusted);
    expect((await legacy.around(effect(),signal(),undefined,execute)).status).toBe('succeeded');
    expect(execute).toHaveBeenCalledTimes(1);
});
it.each(['PostToolUse', 'Stop'] as const)('lets Windows %s finish cold sandbox setup without extending the script deadline', async (event) => {
    // Freeze real local paths first. The adapter is scripted, so no Windows binary is launched.
    const f = await fixture('{}', [event]);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    try {
        vi.useFakeTimers();
        vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
            const controller = new AbortController();
            setTimeout(() => controller.abort(), ms);
            return controller.signal;
        });
        let entered!: () => void;
        const ready = new Promise<void>(resolve => { entered = resolve; });
        const shell = vi.spyOn(adapters, 'runShell').mockImplementation(async (_command, _args, options = {}) => {
            expect(options.timeoutMs).toBe(1000);
            entered();
            await new Promise(resolve => setTimeout(resolve, 40000));
            return { code: options.signal?.aborted ? null : 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: options.signal?.aborted ?? false };
        });
        const execute = vi.fn(async () => ({ value: 'once', status: 'succeeded' as const, sideEffectState: 'applied' as const }));
        let stopping: Promise<void> | undefined;
        if (event === 'Stop') stopping = f.service.stop();
        else expect(await f.service.around(effect(), signal(), undefined, execute)).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' });
        await ready;
        await vi.advanceTimersByTimeAsync(40000);
        await (stopping ?? f.service.stop());
        const receipts = await Promise.all((await readdir(f.journal)).map(async p => JSON.parse(await readFile(join(f.journal, p), 'utf8'))));
        expect(receipts).toEqual([expect.objectContaining({ event, status: 'continue' })]);
        expect(shell).toHaveBeenCalledTimes(1);
        expect(execute).toHaveBeenCalledTimes(event === 'Stop' ? 0 : 1);
    } finally {
        await f.service.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
        Object.defineProperty(process, 'platform', platform);
    }
});

it('uses the confirmed pre decision before native cleanup, but drains teardown before Stop and dispose', async () => {
    const f = await fixture('{}', ['PreToolUse']);
    let release!: () => void;
    const teardown = new Promise<void>(resolve => { release = resolve; });
    const shell = vi.spyOn(adapters, 'runShell').mockImplementation(async (_command, _args, options = {}) => {
        expect(options.timeoutMs).toBe(1000);
        const result = { code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false };
        options.onProcessResult?.(result);
        await teardown;
        return result;
    });
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'once', sideEffectState: 'applied' as const }));
    try {
        const result = await f.service.around(effect(), signal(), undefined, execute);
        expect(result).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' });
        expect(execute).toHaveBeenCalledTimes(1);
        let stopped = false, disposed = false;
        const stop = f.service.stop().then(() => { stopped = true; });
        const dispose = f.service.dispose().then(() => { disposed = true; });
        await new Promise(resolve => setImmediate(resolve));
        expect(stopped).toBe(false);
        expect(disposed).toBe(false);
        release();
        await Promise.all([stop, dispose]);
        expect(stopped && disposed).toBe(true);
        expect(shell).toHaveBeenCalledTimes(1);
    } finally { release(); }
});

it('keeps a late cleanup failure diagnostic, preserves the settled tool, and blocks another pre operation', async () => {
    const f = await fixture('{}', ['PreToolUse']);
    let fail!: (error: Error) => void;
    const teardown = new Promise<void>((_resolve, reject) => { fail = reject; });
    const shell = vi.spyOn(adapters, 'runShell').mockImplementation(async (_command, _args, options = {}) => {
        const result = { code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false };
        options.onProcessResult?.(result);
        await teardown;
        return result;
    });
    const execute = vi.fn(async () => ({ status: 'succeeded' as const, value: 'once', sideEffectState: 'applied' as const }));
    try {
        expect(await f.service.around(effect(), signal(), undefined, execute)).toMatchObject({ status: 'succeeded', sideEffectState: 'applied' });
        fail(Error('SANDBOX_CLEANUP_FAILED'));
        const second = await f.service.around(effect('a2'), signal(), undefined, execute);
        expect(second.error).toMatchObject({ code: 'HOOK_PRE_DENIED', message: 'HOOK_SANDBOX_CLEANUP_FAILED' });
        expect(execute).toHaveBeenCalledTimes(1);
        expect(shell).toHaveBeenCalledTimes(1);
        const receipts = await Promise.all((await readdir(f.journal)).map(p => readFile(join(f.journal, p), 'utf8').then(JSON.parse)));
        expect(receipts).toContainEqual(expect.objectContaining({ event: 'PreToolUse', status: 'continue' }));
        expect(receipts).toContainEqual(expect.objectContaining({ event: 'PreToolUse', status: 'diagnostic', error: 'HOOK_SANDBOX_CLEANUP_FAILED' }));
    } finally { fail(Error('test cleanup')); }
});

it('never executes a cancelled tool even when the script returns a valid pre decision', async () => {
    const f = await fixture('{}', ['PreToolUse']), controller = new AbortController();
    vi.spyOn(adapters, 'runShell').mockImplementation(async () => {
        controller.abort();
        return { code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false };
    });
    const execute = vi.fn();
    expect((await f.service.around(effect(), controller.signal, undefined, execute)).status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
});

it('blocks a tool when cleanup failure is already known before persisting its valid pre decision', async () => {
    const f = await fixture('{}', ['PreToolUse']);
    vi.spyOn(adapters, 'runShell').mockImplementation(async (_command, _args, options = {}) => {
        options.onProcessResult?.({ code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false });
        throw Error('SANDBOX_CLEANUP_FAILED');
    });
    const execute = vi.fn();
    expect((await f.service.around(effect(), signal(), undefined, execute)).error).toMatchObject({ code: 'HOOK_PRE_DENIED', message: 'HOOK_SANDBOX_CLEANUP_FAILED' });
    expect(execute).not.toHaveBeenCalled();
});
