#!/usr/bin/env node
import { dataEndpoint } from '../../packages/data/dist/index.js';
import { readdir, readFile, mkdir, cp, stat, rename, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { ConversationDatabase } from '../../packages/data/dist/sqlite.mjs';
const args = process.argv.slice(2), dataDir = resolve(args[args.indexOf('--data-dir') + 1] ?? '');
if (!args.includes('--data-dir') || !args[args.indexOf('--data-dir') + 1])
    throw new Error('Usage: node scripts/data/migrate.mjs --data-dir /absolute/path [--apply]');
const alive = pid => { try {
    process.kill(pid, 0);
    return true;
}
catch (error) {
    if (error.code === 'ESRCH')
        return false;
    throw error;
} };
const descriptor = await readFile(join(dataDir, 'service.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
    return undefined; throw error; });
if (descriptor?.pid && alive(descriptor.pid))
    throw new Error('STOP_PULSE_SERVICE_BEFORE_MIGRATION');
const writer = await readFile(join(dataDir, '.writer.lock'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
    return undefined; throw error; });
if (writer?.pid && alive(writer.pid))
    throw new Error('STOP_DATA_SERVICE_BEFORE_MIGRATION');
const inbox = await readFile(join(dataDir, 'assistant-inbox.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
    return undefined; throw error; });
const entries = await readdir(join(dataDir, 'conversations'), { withFileTypes: true }).catch(() => []), records = [];
for (const entry of entries) {
    if (!entry.isDirectory())
        continue;
    const directory = join(dataDir, 'conversations', entry.name);
    const lock = await readFile(join(directory, 'conversation.lock'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
        return undefined; throw error; });
    if (lock?.pid && alive(lock.pid))
        throw new Error('CONVERSATION_BUSY');
    const manifest = await readFile(join(directory, 'manifest.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT')
        return undefined; throw error; });
    if (!manifest)
        continue;
    if (manifest.id !== entry.name || typeof manifest.updatedAt !== 'string')
        throw new Error('INVALID_MANIFEST');
    const text = await readFile(join(directory, 'messages.jsonl'), 'utf8').catch(error => { if (error.code === 'ENOENT')
        return ''; throw error; });
    const messages = text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
    for (const message of messages) {
        if (typeof message.id !== 'string' || typeof message.text !== 'string')
            throw new Error('INVALID_MESSAGE');
        // Assistant acceptance is persisted before a Runtime run is created.
        // Queued messages and failures during setup can therefore have only a receipt.
        const acceptedBeforeRun = manifest.id === inbox?.conversationId && message.role === 'user'
            && inbox.messages?.some(receipt => message.id === `msg-${receipt.messageId}`
                && message.runId === receipt.runId && message.text === receipt.text
                && message.createdAt === receipt.createdAt);
        if (message.runId && !manifest.runs.includes(message.runId) && !acceptedBeforeRun)
            throw new Error('MESSAGE_RUN_NOT_IN_MANIFEST');
    }
    records.push({ manifest, messages });
}
if (inbox && !records.some(record => record.manifest.id === inbox.conversationId))
    throw new Error('ASSISTANT_CONVERSATION_MISSING');
console.log(JSON.stringify({ conversations: records.length, messages: records.reduce((count, item) => count + item.messages.length, 0), apply: args.includes('--apply') }));
if (!args.includes('--apply'))
    process.exit(0);
// Existing broker means another new-version process owns the database. Never race it.
const endpoint = dataEndpoint(dataDir);
const connected = await new Promise(resolveProbe => { const socket = createConnection(endpoint); socket.once('connect', () => { socket.destroy(); resolveProbe(true); }); socket.once('error', () => resolveProbe(false)); });
if (connected)
    throw new Error('STOP_DATA_SERVICE_BEFORE_MIGRATION');
const lock = await open(join(dataDir, 'migration.lock'), 'wx', 0o600);
let database;
try {
    const backup = join(dataDir, `migration-backup-${Date.now()}`);
    await mkdir(backup, { mode: 0o700 });
    for (const name of ['conversations', 'assistant-inbox.json', 'pulse.sqlite', 'pulse.sqlite-wal', 'pulse.sqlite-shm'])
        if (await stat(join(dataDir, name)).then(() => true, () => false))
            await cp(join(dataDir, name), join(backup, name), { recursive: true });
    database = new ConversationDatabase(dataDir);
    for (const record of records) {
        let existing;
        try {
            existing = database.get(record.manifest.id);
        }
        catch { }
        if (existing) {
            if (JSON.stringify(existing) !== JSON.stringify(record.manifest) || JSON.stringify(database.messages(record.manifest.id)) !== JSON.stringify(record.messages))
                throw new Error('MIGRATION_TARGET_CONFLICT');
            continue;
        }
        database.save(record.manifest);
        for (const message of record.messages)
            database.append(record.manifest.id, message);
        if (database.messages(record.manifest.id).length !== record.messages.length)
            throw new Error('MIGRATION_COUNT_MISMATCH');
    }
    if (inbox)
        database.saveState('assistant-inbox', inbox);
    database.saveState('migration', { version: 1, completedAt: new Date().toISOString(), conversations: records.length });
    console.log(JSON.stringify({ ok: true, backup, conversations: records.length }));
}
finally {
    database?.close();
    await lock.close();
    await rm(join(dataDir, 'migration.lock'), { force: true });
}
