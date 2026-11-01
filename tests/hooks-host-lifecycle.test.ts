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
