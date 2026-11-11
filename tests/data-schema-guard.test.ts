import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { ConversationDatabase, schemaVersion } from '../packages/data/src/sqlite.mjs';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
const directories: string[] = [];
const temporary = () => { const dir = mkdtempSync(join(tmpdir(), 'pulse-schema-guard-')); directories.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function snapshot(dir: string) {
    const file = join(dir, 'pulse.sqlite'), db = new DatabaseSync(file, { readOnly: true });
    let content;
    try {
        content = { version: db.prepare('PRAGMA user_version').get().user_version,
            journal: db.prepare('PRAGMA journal_mode').get().journal_mode,
            schema: db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name').all(),
            sentinel: db.prepare('SELECT * FROM sentinel').all() };
    } finally { db.close(); }
    return { ...content, digest: createHash('sha256').update(readFileSync(file)).digest('hex'),
        mode: statSync(file).mode & 0o777, files: readdirSync(dir).sort() };
}
for (const version of [schemaVersion + 1, 99, 0]) for (const readOnly of [false, true]) {
    it(`rejects nonempty schema ${version} readOnly=${readOnly} without mutations or an open handle`, () => {
        const dir = temporary(), db = new DatabaseSync(join(dir, 'pulse.sqlite'));
        db.exec(`CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('untouched'); PRAGMA user_version=${version};`);
        db.close(); chmodSync(join(dir, 'pulse.sqlite'), 0o640);
        const before = snapshot(dir), close = vi.spyOn(DatabaseSync.prototype, 'close');
        expect(() => new ConversationDatabase(dir, readOnly)).toThrow('DATA_SCHEMA_INCOMPATIBLE');
        expect(close).toHaveBeenCalledTimes(1);
        expect(close.mock.contexts[0].isOpen).toBe(false);
        close.mockRestore();
        expect(snapshot(dir)).toEqual(before);
    });
}
it('initializes a fresh or empty schema-zero database and reopens supported data in both modes', () => {
    for (const existing of [false, true]) {
        const dir = temporary();
        if (existing) new DatabaseSync(join(dir, 'pulse.sqlite')).close();
        const db = new ConversationDatabase(dir);
        const conversation = { id: 'synthetic', updatedAt: '2026-01-01', title: 'Preserved' };
        const message = { id: 'message', text: 'Local only' };
        try { db.save(conversation); db.append(conversation.id, message); db.saveState('migration', { complete: true }); }
        finally { db.close(); }
        for (const readOnly of [false, true]) {
            const reopened = new ConversationDatabase(dir, readOnly);
            try { expect(reopened.get(conversation.id)).toEqual(conversation); expect(reopened.messages(conversation.id)).toEqual([message]); expect(reopened.readState('migration')).toEqual({ complete: true }); }
            finally { reopened.close(); }
        }
    }
});
it('closes and rolls back if supported-schema initialization fails', () => {
    const dir = temporary(), db = new DatabaseSync(join(dir, 'pulse.sqlite'));
    db.exec(`CREATE TABLE conversations(id TEXT); PRAGMA user_version=${schemaVersion};`); db.close();
    const close = vi.spyOn(DatabaseSync.prototype, 'close');
    expect(() => new ConversationDatabase(dir)).toThrow();
    expect(close).toHaveBeenCalledTimes(2); expect(close.mock.contexts.every(db => !db.isOpen)).toBe(true);
    close.mockRestore();
    const check = new DatabaseSync(join(dir, 'pulse.sqlite'));
    try { expect(check.prepare("SELECT name FROM sqlite_master WHERE name='messages'").get()).toBeUndefined(); }
    finally { check.close(); }
});
it('keeps the offline migration script compatible with guarded initialization and repeat apply', () => {
    const dir = temporary(), data = join(dir, 'data'), source = join(data, 'conversations', 'conv-synthetic');
    mkdirSync(source, { recursive: true });
    const manifest = { id: 'conv-synthetic', title: 'Synthetic migration', updatedAt: '2026-01-01', runs: [] };
    const message = { id: 'message', text: 'Offline migration' };
    writeFileSync(join(source, 'manifest.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'messages.jsonl'), JSON.stringify(message) + '\n');
    // Exercise the production migration algorithm against source without rebuilding dist.
    const script = readFileSync(resolve('scripts/data/migrate.mjs'), 'utf8')
        .replace('../../packages/data/dist/index.js', pathToFileURL(resolve('packages/data/dist/index.js')).href)
        .replace('../../packages/data/dist/sqlite.mjs', pathToFileURL(resolve('packages/data/src/sqlite.mjs')).href);
    const scriptPath = join(dir, 'migrate.mjs'); writeFileSync(scriptPath, script);
    for (let attempt = 0; attempt < 2; attempt++) {
        const output = execFileSync(process.execPath, [scriptPath, '--data-dir', data, '--apply'], {
            encoding: 'utf8', env: { ...process.env, HOME: dir, PULSE_HOME: dir, PULSE_DATA_DIR: data }, timeout: 10000,
        });
        expect(output).toContain('"ok":true');
    }
    const db = new ConversationDatabase(data, true);
    try { expect(db.get(manifest.id)).toEqual(manifest); expect(db.messages(manifest.id)).toEqual([message]); }
    finally { db.close(); }
    expect(readFileSync(join(source, 'messages.jsonl'), 'utf8')).toBe(JSON.stringify(message) + '\n');
});

for (const journal of ['WAL', 'DELETE']) for (const readOnly of [false, true]) {
    it(`preserves main and recovery bytes for interrupted ${journal} schema99 readOnly=${readOnly}`, () => {
        const dir = temporary(), file = join(dir, 'pulse.sqlite'), ready = join(dir, 'interruption-ready');
        const seed = new DatabaseSync(file);
        seed.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES('committed'); PRAGMA user_version=99;");
        seed.close();
        const sql = journal === 'WAL'
            ? "INSERT INTO sentinel VALUES('wal-committed');"
            : "BEGIN IMMEDIATE; UPDATE sentinel SET value='uncommitted'; CREATE TABLE spill(x); INSERT INTO spill SELECT randomblob(4096) FROM json_each('[1,2,3,4,5,6,7,8]');";
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
            import { DatabaseSync } from 'node:sqlite';
            import { writeFileSync } from 'node:fs';
            try {
                const db = new DatabaseSync(${JSON.stringify(file)});
                db.exec(${JSON.stringify(`PRAGMA journal_mode=${journal}; PRAGMA cache_size=1; ${sql}`)});
                writeFileSync(${JSON.stringify(ready)}, ${JSON.stringify(journal)}, { flag: 'wx' });
                process.kill(process.pid, 'SIGKILL');
            } catch (error) { console.error(error); process.exit(77); }
            process.exit(78); // Self-termination must not return or close SQLite cleanly.
        `], { encoding: 'utf8', timeout: 10000 });
        expect(child.error, child.stderr).toBeUndefined();
        expect(readFileSync(ready, 'utf8')).toBe(journal);
        // Windows uv_kill uses TerminateProcess(..., 1). A self-kill does not set
        // the parent's uv_process_t.exit_signal, unlike child.kill('SIGKILL').
        // The post-SQL marker and distinct failure exits rule out loader/SQL errors.
        expect({ status: child.status, signal: child.signal }, child.stderr).toEqual(process.platform === 'win32'
            ? { status: 1, signal: null } : { status: null, signal: 'SIGKILL' });
        const recovery = file + (journal === 'WAL' ? '-wal' : '-journal');
        const before = { main: readFileSync(file), recovery: readFileSync(recovery) };
        const close = vi.spyOn(DatabaseSync.prototype, 'close');
        // Hot rollback journals cannot be read without recovery. Read-only probing
        // deliberately fails closed with SQLite's error rather than recovering them.
        expect(() => new ConversationDatabase(dir, readOnly)).toThrow(journal === 'WAL' ? 'DATA_SCHEMA_INCOMPATIBLE' : /readonly|read-only/i);
        expect(close).toHaveBeenCalledTimes(1); expect(close.mock.contexts[0].isOpen).toBe(false); close.mockRestore();
        expect({ main: readFileSync(file), recovery: readFileSync(recovery) }).toEqual(before);
        // Recovery on an independent copy verifies the preserved logical content.
        // WAL SHM is an SQLite index/lock sidecar, not part of the byte guarantee.
        const copy = temporary(), copiedFile = join(copy, 'pulse.sqlite');
        writeFileSync(copiedFile, before.main); writeFileSync(copiedFile + (journal === 'WAL' ? '-wal' : '-journal'), before.recovery);
        const check = new DatabaseSync(copiedFile);
        try {
            expect(check.prepare('PRAGMA user_version').get().user_version).toBe(99);
            expect(check.prepare('SELECT value FROM sentinel').all().map(row => row.value)).toEqual(journal === 'WAL' ? ['committed', 'wal-committed'] : ['committed']);
        } finally { check.close(); }
    });
}
it('rechecks the schema under the write transaction after read-only preflight', () => {
    const dir = temporary(), initial = new ConversationDatabase(dir); initial.close();
    const originalClose = DatabaseSync.prototype.close;
    let changed = false;
    const close = vi.spyOn(DatabaseSync.prototype, 'close').mockImplementationOnce(function () {
        originalClose.call(this);
        const concurrent = new DatabaseSync(join(dir, 'pulse.sqlite'));
        concurrent.exec('PRAGMA user_version=99'); originalClose.call(concurrent); changed = true;
    });
    expect(() => new ConversationDatabase(dir)).toThrow('DATA_SCHEMA_INCOMPATIBLE');
    expect(changed).toBe(true); expect(close.mock.contexts.every(db => !db.isOpen)).toBe(true); close.mockRestore();
    const check = new DatabaseSync(join(dir, 'pulse.sqlite'), { readOnly: true });
    try { expect(check.prepare('PRAGMA user_version').get().user_version).toBe(99); }
    finally { check.close(); }
});
