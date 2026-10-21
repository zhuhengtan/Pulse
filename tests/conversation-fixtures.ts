import { basename, dirname } from 'node:path';
import { ConversationData } from '../packages/data/src/index.js';
/** Fixture-only bridge for tests that deliberately seed persisted records. No production file fallback. */
export async function readConversationFixture(path: string, encoding?: string): Promise<any> {
    const id = basename(dirname(path)), directory = dirname(dirname(dirname(path))), data = new ConversationData(directory);
    try {
        let text: string;
        if (basename(path) === 'manifest.json')
            text = JSON.stringify(await data.call('get', id));
        else {
            const messages = basename(path).endsWith('.bak') ? await data.call<unknown[]>('readState', `compaction-backup:${id}`) : await data.call<unknown[]>('messages', id);
            text = (messages ?? []).map(item => JSON.stringify(item) + '\n').join('');
        }
        return encoding ? text : Buffer.from(text);
    }
    finally {
        data.close();
    }
}
export async function writeConversationFixture(path: string, text: string | Buffer, options?: unknown): Promise<void> {
    const id = basename(dirname(path)), directory = dirname(dirname(dirname(path))), data = new ConversationData(directory);
    try {
        if (basename(path) === 'manifest.json')
            await data.call('save', JSON.parse(String(text)));
        else {
            const messages = String(text).split('\n').filter(Boolean).flatMap(line => { try {
                return [JSON.parse(line)];
            }
            catch {
                return [];
            } });
            if ((options as {
                flag?: string;
            })?.flag === 'a') {
                for (const item of messages)
                    await data.call('append', id, item);
            }
            else
                await data.call('replace', id, messages);
        }
    }
    finally {
        data.close();
    }
}
