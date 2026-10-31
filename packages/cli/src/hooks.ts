import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadHookDefinitions, checkHookDefinitions, withConfigFileLock, type HookConfig } from '@hunterzhu/pulse-server';
export async function runHooksCommand(args: string[], configPath: string): Promise<number> {
    const [command, value] = args;
    if (!['load', 'check', 'enable', 'disable'].includes(command ?? ''))
        throw Error('Usage: pulse hooks load <definition.json> | check | enable <hash> | disable [--config <host-config>]');
    return withConfigFileLock(configPath, async () => {
        const current = await readFile(configPath, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
            return '{}'; throw e; }), config = JSON.parse(current);
        if (command === 'load') {
            if (!value)
                throw Error('HOOK_DEFINITION_PATH_REQUIRED');
            const loaded = await loadHookDefinitions(resolve(value), join(dirname(configPath), 'hooks'));
            config.hooks = { ...loaded, enabled: false };
        }
        else {
            let hooks = config.hooks as HookConfig | undefined;
            if ((command === 'enable' || command === 'check') && value !== undefined) {
                if (!/^[a-f0-9]{64}$/.test(value)) throw Error('HOOK_EXPLICIT_HASH_REQUIRED');
                hooks = { hash: value, directory: join(dirname(configPath), 'hooks', value), enabled: config.hooks?.hash === value && config.hooks?.enabled === true };
            }
            if (!hooks)
                throw Error('HOOK_NOT_LOADED');
            if (command === 'check') {
                const definitions = await checkHookDefinitions(hooks);
                process.stdout.write(JSON.stringify({ hash: hooks.hash, enabled: hooks.enabled === true, valid: true, definitions: definitions.map(({ event, matcher, command, args, assets, timeoutMs }) => ({ event, matcher, command, args, assets, timeoutMs })) }) + '\n');
                return 0;
            }
            if (command === 'enable') {
                if (!value || value !== hooks.hash)
                    throw Error('HOOK_EXPLICIT_HASH_REQUIRED');
                await checkHookDefinitions(hooks);
            }
            config.hooks = { ...hooks, enabled: command === 'enable' };
        }
        const temporary = configPath + '.' + randomUUID() + '.tmp';
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, configPath);
        process.stdout.write(JSON.stringify({ hash: config.hooks.hash, enabled: config.hooks.enabled }) + '\n');
        return 0;
    });
}
