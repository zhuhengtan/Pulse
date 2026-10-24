import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConversationData } from '../packages/data/src/index.js';
import { ConversationDatabase } from '../packages/data/src/sqlite.mjs';
describe('shared conversation data', () => {
    it('coordinates concurrent writers, pages without duplicates, and permits independent local readers', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'pulse-data-'));
        const a = new ConversationData(directory), b = new ConversationData(directory);
        try {
            await Promise.all([a.call('save', { id: 'a', updatedAt: '2026-01-01', title: 'A' }), b.call('save', { id: 'b', updatedAt: '2026-01-01', title: 'B' })]);
            await Promise.all(Array.from({ length: 110 }, (_, i) => (i % 2 ? a : b).call('append', 'a', { id: `m${i}`, text: `text ${i}`, role: 'user', createdAt: '2026-01-01' })));
            const first = await a.call<{
                items: Array<{
                    id: string;
                }>;
                before: string;
            }>('page', 'a', undefined, 50);
            const second = await b.call<{
                items: Array<{
                    id: string;
                }>;
                before: string;
            }>('page', 'a', first.before, 50);
            expect(first.items).toHaveLength(50);
            expect(second.items).toHaveLength(50);
            expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(100);
            await Promise.all([a.call('patch', 'a', { title: 'Renamed' }), b.call('patch', 'a', { activeRunId: 'run-active' })]);
            expect(await a.call('get', 'a')).toMatchObject({ title: 'Renamed', activeRunId: 'run-active' });
            const reader = new ConversationDatabase(directory, true);
            try {
                expect(reader.list()).toHaveLength(2);
                expect(reader.page('a').items).toHaveLength(50);
            }
            finally {
                reader.close();
            }
            await expect(a.call('append', 'a', { id: 'm1', text: 'different' })).rejects.toThrow('MESSAGE_ID_REUSED');
            await a.call('remove', 'a');
            expect(await b.call('messages', 'a')).toEqual([]);
        }
        finally {
            await a.close();
            await b.close();
            await rm(directory, { recursive: true, force: true });
        }
    });
});
