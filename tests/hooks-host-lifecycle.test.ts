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
import { defineTool } from '@hunterzhu/pulse-tool-sdk';
import { z } from 'zod';
import { roots, services, openService, fixture, effect, signal, nativeTimeout } from './support/hook-fixture.js';
it('executes the real Host effect boundary and Stop lifecycle using mock models only', async () => {
    const f = await fixture(), dataDir = join(f.base, 'data'), host = createLocalHost({ cwd: f.root, dataDir, hooks: f.trusted, taskController: false, approvalMode: 'auto', mockToolCalls: [{ name: 'fs.read', input: { path: 'a.txt' } }], mockAfterToolResponse: 'done' });
    await host.init();
    try {
        const c = await host.createConversation({ cwd: f.root });
        const run = await host.sendMessage(c.id, { text: 'Read a.txt' });
        const outcome = await run.outcome();
        const journal = join(dataDir, 'conversations', c.id, 'runs', run.id, 'hooks');
        const receipts = await Promise.all((await readdir(journal)).map(p => readFile(join(journal, p), 'utf8').then(JSON.parse)));
        expect(outcome.status, JSON.stringify({ outcome, receipts })).toBe('succeeded');
        expect(receipts.map(r => r.event).sort(), JSON.stringify(receipts)).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
        expect(receipts.every(r => r.runId === run.id && r.definitionHash === f.snapshot.hash)).toBe(true);
    }
    finally {
        await host.close();
    }
}, nativeTimeout(4, 30000));

it.each([false, true])('keeps the real short Host deadline with a scripted delayed cleanup (process receipt=%s)', async confirmed => {
    const f = await fixture('{}', ['PreToolUse']);
    const raw = JSON.parse(await readFile(f.file, 'utf8'));
    raw.hooks.PreToolUse[0].matcher = 'probe.read';
    await writeFile(f.file, JSON.stringify(raw));
    const snapshot = await loadHookDefinitions(f.file, join(f.base, 'short-deadline'));
    let calls = 0, cleaned = false;
    const shell = vi.spyOn(adapters, 'runShell').mockImplementation(async (_command, _args, options = {}) => {
        expect(options.timeoutMs).toBe(1000);
        const result = { code: 0, stdout: '{}', stderr: '', truncated: false, timedOut: false, aborted: false };
        if (confirmed) options.onProcessResult?.(result);
        await new Promise(resolve => setTimeout(resolve, 3000));
        cleaned = true;
        return result;
    });
    const host = createLocalHost({ cwd: f.root, dataDir: join(f.base, 'short-data'), hooks: { ...snapshot, enabled: true }, taskController: false, approvalMode: 'auto', enabledCapabilityPacks: ['probe'], capabilityPacks: [{ manifest: { id: 'probe', version: '1', kind: 'integration', title: 'fixture', description: 'local only' }, activate: async () => ({ tools: [defineTool({ name: 'probe.read', description: 'fixture', input: z.object({}), output: z.object({ ok: z.boolean() }), sideEffectPolicy: 'read', defaultTimeoutMs: 1500, execute: async () => { calls++; return { ok: true }; } })] }) }], mockToolCalls: [{ name: 'probe.read', input: {} }], mockAfterToolResponse: 'done' });
    try {
        const c = await host.createConversation(), run = await host.sendMessage(c.id, { text: 'Run local read' });
        const outcome = await run.outcome();
        // The negative control deliberately recreates waiting for cleanup.
        // Both controls keep the same 1.5s tool and 1s hook budgets.
        expect(outcome.status, JSON.stringify(outcome)).toBe(confirmed ? 'succeeded' : 'failed');
        if (!confirmed) expect(outcome.error?.code).toBe('ATTEMPT_TIMEOUT');
        expect(calls).toBe(confirmed ? 1 : 0);
        expect(cleaned).toBe(true);
        expect(shell).toHaveBeenCalledTimes(1);
    } finally { await host.close(); }
}, 15000);
