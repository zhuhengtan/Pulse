import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HookService, loadHookDefinitions, checkHookDefinitions, hookArgv, hookMatches } from '../../packages/server/src/hooks/index.js';
import { createLocalHost } from '../../packages/server/src/index.js';
import { runShell } from '../../packages/adapters/src/tools/shell.js';
import * as adapters from '@hunterzhu/pulse-adapters';
import { ShellProcesses } from '../../packages/server/src/shell-processes.js';
import type { EffectRecord } from '@hunterzhu/pulse-runtime';
export const roots: string[] = [];
export const services: HookService[] = [];
export const openService = (...args: ConstructorParameters<typeof HookService>) => { const service = new HookService(...args); services.push(service); return service };
afterEach(async () => {
    const pending = services.splice(0);
    // Drain owned scripts; cleanup must not start a new Stop hook on an unused fixture.
    try { for (const service of pending) await service.dispose(); }
    finally { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map(p => rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))); }
}, process.platform === 'win32' ? 280000 : 10000);
export async function fixture(output = '{}', events = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
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
export const effect = (attemptId = 'a1') => ({ id: 'e1', kind: 'tool', attemptId, attemptNo: 1, agentId: 'agent', ownerLaneId: 'lane', toolCallId: 'tc', input: { name: 'fs.read', arguments: { path: 'a.txt', token: 'secret' } } }) as EffectRecord;
export const signal = () => new AbortController().signal;
// Budget only whole native cases for measured Windows sandbox ACL setup.
export const nativeTimeout = (launches: number, local = 30000) => process.platform === 'win32' ? launches * 240000 : local;
