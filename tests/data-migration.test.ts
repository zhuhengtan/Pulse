import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { ConversationData } from '../packages/data/src/index.js';
import { ConversationDatabase } from '../packages/data/dist/sqlite.mjs';
const exec = promisify(execFile);
it('migrates offline data once, preserves sources, validates repeat runs and refuses a live writer', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-migrate-')), id = 'conv-migration', source = join(directory, 'conversations', id);
    await mkdir(source, { recursive: true });
    const manifest = { schemaVersion: 1, id, title: 'Migrated', updatedAt: '2026-01-01', createdAt: '2026-01-01', cwd: directory, runs: ['run-old'], artifacts: [] };
    const message = { id: 'old-message', role: 'assistant', text: 'Local answer', runId: 'run-old', createdAt: '2026-01-01', displayVersion: 1 };
    const original = JSON.stringify(message) + '\n';
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'messages.jsonl'), original);
    const command = [resolve('scripts/data/migrate.mjs'), '--data-dir', directory];
    let data: ConversationData | undefined;
    try {
        const dry = await exec(process.execPath, command);
        expect(dry.stdout).toContain('"apply":false');
        expect(await readdir(directory)).not.toContain('pulse.sqlite');
        await expect(new ConversationData(directory).call('list')).rejects.toThrow('DATA_MIGRATION_REQUIRED');
        const migrated = await exec(process.execPath, [...command, '--apply']);
        expect(migrated.stdout).toContain('"ok":true');
        await exec(process.execPath, [...command, '--apply']);
        data = new ConversationData(directory);
        expect(await data.call('messages', id)).toEqual([message]);
        expect(await readFile(join(source, 'messages.jsonl'), 'utf8')).toBe(original);
        await expect(exec(process.execPath, [...command, '--apply'])).rejects.toThrow('STOP_DATA_SERVICE_BEFORE_MIGRATION');
        expect((await readdir(directory)).filter(name => name.startsWith('migration-backup-')).length).toBe(2);
    }
    finally {
        await data?.close();
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
});

it('preserves assistant messages accepted before run creation only with a matching inbox receipt', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pulse-migrate-receipt-'));
    const id = 'conv-assistant', source = join(directory, 'conversations', id);
    await mkdir(source, { recursive: true });
    const manifest = { id, updatedAt: '2026-01-01', runs: [] };
    const receipt = { messageId: 'request', runId: 'run-not-created', text: 'hello', createdAt: '2026-01-01', state: 'failed' };
    const message = { id: 'msg-request', role: 'user', text: receipt.text, runId: receipt.runId, createdAt: receipt.createdAt };
    await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(source, 'messages.jsonl'), JSON.stringify(message) + '\n');
    const inboxPath = join(directory, 'assistant-inbox.json');
    const command = [resolve('scripts/data/migrate.mjs'), '--data-dir', directory];
    try {
        await expect(exec(process.execPath, command)).rejects.toThrow('MESSAGE_RUN_NOT_IN_MANIFEST');
        await writeFile(inboxPath, JSON.stringify({ conversationId: id, messages: [{ ...receipt, text: 'different' }] }));
        await expect(exec(process.execPath, command)).rejects.toThrow('MESSAGE_RUN_NOT_IN_MANIFEST');
        await writeFile(inboxPath, JSON.stringify({ conversationId: id, messages: [receipt] }));
        await exec(process.execPath, [...command, '--apply']);
        const database = new ConversationDatabase(directory, true);
        try { expect(database.messages(id)).toEqual([message]); }
        finally { database.close(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
});
