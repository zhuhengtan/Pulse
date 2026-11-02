import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { resolveShellIdentity, validateShellInvocation, runShell, type ShellIdentity, type ShellResult } from '@hunterzhu/pulse-adapters';
import type { EffectRecord, EffectExecution, EffectExecutor } from '@hunterzhu/pulse-runtime';
import { replaceStateFile } from '../atomic-file.js';
export const hookEvents = ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop'] as const;
export type HookEvent = typeof hookEvents[number];
export interface HookDefinition {
    event: HookEvent;
    matcher: string;
    command: string;
    args: string[];
    timeoutMs: number;
    identity: ShellIdentity;
    assets: Record<string, string>;
}
export interface HookConfig {
    enabled?: boolean;
    hash: string;
    directory: string;
}
export interface HookSnapshot {
    hash: string;
    directory: string;
}
// Windows sandbox ACL setup can take over a minute before the script timer starts.
// Keep the script's configured deadline; only the observer envelope includes setup.
const observerTimeoutMs = () => process.platform === 'win32' ? 275000 : 35000;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
const inside = (root: string, file: string) => { const p = relative(root, file); return !isAbsolute(p) && p !== '..' && !p.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')); };
const definitionSchema = z.object({ event: z.enum(hookEvents), matcher: z.string().max(500), command: z.string(), args: z.array(z.string()).max(100), timeoutMs: z.number().int().min(100).max(30000), identity: z.object({ executable: z.string(), prefixArgs: z.array(z.string()), path: z.string(), fingerprint: z.string(), trusted: z.boolean() }), assets: z.record(z.string()) }).strict();
/** Simple argv, not a shell. Compound commands and expansion are intentionally unsupported. */
export function hookArgv(command: string | string[]): string[] {
    if (Array.isArray(command)) {
        if (!command.length || command.some(x => typeof x !== 'string' || x.includes('\0')))
            throw Error('HOOK_COMMAND_INVALID');
        validateShellInvocation(command[0]!, command.slice(1));
        return command;
    }
    if (typeof command !== 'string' || /[\n`$;&|<>]/.test(command))
        throw Error('HOOK_SHELL_SYNTAX_UNSUPPORTED');
    const words = command.match(/"[^"\n]*"|'[^'\n]*'|[^\s"']+/g) ?? [];
    if (words.join(' ').replace(/\s+/g, ' ') !== command.trim().replace(/\s+/g, ' '))
        throw Error('HOOK_COMMAND_INVALID');
    const argv = words.map(s => /^["']/.test(s) ? s.slice(1, -1) : s);
    validateShellInvocation(argv[0] ?? '', argv.slice(1));
    return argv;
}
export function hookMatches(matcher: string, name: string): boolean {
    if (matcher === '') return true;
    const aliases: Record<string, string[]> = { 'shell.exec': ['Bash'], 'shell.start': ['Bash'], 'fs.read': ['Read'], 'fs.view_image': ['Read'], 'fs.write': ['Write'], 'fs.overwrite': ['Write'], 'fs.stage': ['Write'], 'fs.apply_patch': ['Edit'], 'fs.apply_patches': ['Edit', 'MultiEdit'], 'fs.glob': ['Glob'], 'fs.search': ['Grep'] };
    const tokens = matcher.split('|').map(part => part.replace(/^\^/, '').replace(/\$$/, ''));
    for (const token of tokens) if (!['*', '.*'].includes(token) && !/^[a-zA-Z0-9_.-]+(?:\.\*)?$/.test(token)) throw Error('HOOK_MATCHER_UNSUPPORTED');
    const names = [name, ...(aliases[name] ?? [])];
    return tokens.some(token => token === '*' || token === '.*' || (token.endsWith('.*') ? names.some(n => n.startsWith(token.slice(0, -2))) : names.includes(token)));
}
export async function loadHookDefinitions(file: string, storage: string): Promise<HookSnapshot> {
    const source = await realpath(file), base = dirname(source);
    if ((await stat(source)).size > 262144) throw Error('HOOK_CONFIG_TOO_LARGE');
    const raw = await readFile(source, 'utf8');
    if (Buffer.byteLength(raw) > 262144)
        throw Error('HOOK_CONFIG_TOO_LARGE');
    const parsed = JSON.parse(raw), hooks = parsed.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks))
        throw Error('HOOK_CONFIG_INVALID');
    let totalAssetBytes = 0;
    const staged: Array<{
        definition: HookDefinition;
        files: Record<string, Buffer>;
    }> = [];
    for (const [event, groups] of Object.entries(hooks)) {
        if (!hookEvents.includes(event as HookEvent) || !Array.isArray(groups))
            throw Error('HOOK_EVENT_UNSUPPORTED');
        for (const group of groups) {
            if (!group || !Array.isArray(group.hooks) || Object.keys(group).some(k => !['matcher', 'hooks'].includes(k)))
                throw Error('HOOK_CONFIG_INVALID');
            const matcher = group.matcher ?? '';
            if (typeof matcher !== 'string' || event === 'Stop' && matcher !== '')
                throw Error('HOOK_MATCHER_UNSUPPORTED');
            hookMatches(matcher, '__validate');
            for (const spec of group.hooks) {
                if (spec.type !== 'command' || Object.keys(spec).some(k => !['type', 'command', 'timeout', 'assets'].includes(k)))
                    throw Error('HOOK_HANDLER_UNSUPPORTED');
                if (spec.timeout !== undefined && (typeof spec.timeout !== 'number' || !Number.isFinite(spec.timeout))) throw Error('HOOK_TIMEOUT_INVALID');
                if (spec.assets !== undefined && !Array.isArray(spec.assets)) throw Error('HOOK_ASSET_INVALID');
                const argv = hookArgv(spec.command);
                if (argv.some(arg => arg.startsWith('@asset/')))
                    throw Error('HOOK_RESERVED_ARGUMENT');
                if (!argv[0])
                    throw Error('HOOK_COMMAND_INVALID');
                const identity = await resolveShellIdentity(argv[0], argv.slice(1), base), files: Record<string, Buffer> = Object.create(null), assets: Record<string, string> = Object.create(null);
                if (inside(base, identity.executable))
                    throw Error('HOOK_USE_INSTALLED_INTERPRETER');
                const paths = [...(Array.isArray(spec.assets) ? spec.assets : []), ...argv.slice(1).filter(arg => /\.(?:[cm]?js|py|sh|ps1)$/i.test(arg))];
                if (paths.length > 32) throw Error('HOOK_ASSET_COUNT_EXCEEDED');
            for (const arg of paths) {
                    if (typeof arg !== 'string')
                        throw Error('HOOK_ASSET_INVALID');
                    const path = await realpath(resolve(base, arg));
                    if (!inside(base, path))
                        throw Error('HOOK_ASSET_OUTSIDE_DEFINITION');
                    const rel = relative(base, path);
                    const size = await stat(path); if (!size.isFile() || size.size > 2097152) throw Error('HOOK_ASSET_TOO_LARGE');
                    const bytes = await readFile(path);
                    totalAssetBytes += bytes.length; if (totalAssetBytes > 16777216) throw Error('HOOK_ASSETS_TOO_LARGE');
                    if (bytes.length > 2097152)
                        throw Error('HOOK_ASSET_TOO_LARGE');
                    files[rel] = bytes;
                    assets[rel] = hash(bytes);
                }
                if (identity.prefixArgs.length)
                    throw Error('HOOK_WRAPPER_UNSUPPORTED');
                const timeoutMs = (spec.timeout ?? 10) * 1000;
                const definition = definitionSchema.parse({ event, matcher, command: identity.executable, args: [...identity.prefixArgs, ...argv.slice(1).map(arg => { const rel = relative(base, resolve(base, arg)); return Object.hasOwn(assets, rel) ? '@asset/' + rel : arg; })], timeoutMs, identity, assets });
                staged.push({ definition, files });
                if (staged.length > 64)
                    throw Error('HOOK_COUNT_EXCEEDED');
            }
        }
    }
    const definitions = staged.map(s => s.definition), digest = hash(JSON.stringify(definitions)), directory = join(resolve(storage), digest);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const { files } of staged)
        for (const [path, bytes] of Object.entries(files)) {
            const target = join(directory, 'assets', path);
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            await writeFile(target, bytes, { mode: 0o600 });
        }
    await writeFile(join(directory, 'definitions.json'), JSON.stringify(definitions), { mode: 0o600 });
    return { hash: digest, directory };
}
export async function checkHookDefinitions(config: HookSnapshot): Promise<HookDefinition[]> {
    const directory = await realpath(config.directory);
    if ((await stat(join(directory, 'definitions.json'))).size > 262144) throw Error('HOOK_DEFINITION_CHANGED');
    const bytes = await readFile(join(directory, 'definitions.json'));
    if (bytes.length > 262144 || hash(bytes) !== config.hash)
        throw Error('HOOK_DEFINITION_CHANGED');
    const definitions = z.array(definitionSchema).max(64).parse(JSON.parse(bytes.toString('utf8')));
    for (const d of definitions) {
        hookMatches(d.matcher, '__validate');
        for (const [path, digest] of Object.entries(d.assets)) {
            const target = await realpath(join(directory, 'assets', path));
            if (!inside(directory, target) || (await stat(target)).size > 2097152 || hash(await readFile(target)) !== digest)
                throw Error('HOOK_ASSET_CHANGED');
        }
    }
    return definitions;
}
function redacted(value: unknown, depth = 0): unknown {
    if (depth > 6)
        return '[clipped]';
    if (typeof value === 'string')
        return value.slice(0, 4000).replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]').replace(/(?:Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"',]+/gi, '[redacted]');
    if (Array.isArray(value))
        return value.slice(0, 30).map((v, i) => i > 0 && typeof value[i - 1] === 'string' && /token|key|secret|password|authorization|cookie/i.test(value[i - 1]) ? '[redacted]' : redacted(v, depth + 1));
    if (value && typeof value === 'object')
        return Object.fromEntries(Object.entries(value).slice(0, 40).map(([k, v]) => [k, /token|key|secret|password|authorization|cookie|content|text|prompt|reasoning|body/i.test(k) ? '[redacted]' : redacted(v, depth + 1)]));
    return value;
}
function hookToolInput(name: string, args: unknown): unknown {
    if (name !== 'shell.stdin' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
    if (!Object.hasOwn(args, 'data')) return args;
    const record = { ...(args as Record<string, unknown>) };
    const data = record.data;
    if (typeof data === 'string' && record.bytes === undefined) record.bytes = Buffer.byteLength(data);
    record.data = '[redacted]';
    return record;
}
export class HookService {
    private start: Promise<void> | undefined;
    private readonly postController = new AbortController();
    private readonly pending = new Set<Promise<void>>();
    private readonly activeHooks = new Set<Promise<void>>();
    private readonly cleanup = new Set<Promise<void>>();
    private cleanupFailed = false;
    constructor(private readonly root: string, private readonly journal: string, private readonly owner: {
        conversationId: string;
        runId: string;
    }, private readonly snapshot: HookSnapshot | undefined, private readonly trusted: HookConfig | undefined, private readonly source: 'startup' | 'resume' = 'startup') { }
    async sessionStart(signal: AbortSignal): Promise<void> {
        // At the next Host dispatch, drain previous native teardown before a
        // fresh model/tool operation. No sandbox lease is released early.
        await Promise.all([...this.cleanup]);
        return this.start ??= this.fire('SessionStart', undefined, undefined, signal);
    }
    async stop(): Promise<void> { await Promise.allSettled([...this.pending]); try {
        await Promise.all([...this.cleanup]);
        await this.fire('Stop', undefined, undefined, AbortSignal.timeout(observerTimeoutMs()));
    }
    catch (error) { await this.diagnostic('Stop', error); } }
    async around(effect: EffectRecord, signal: AbortSignal, observe: Parameters<EffectExecutor>[2], execute: EffectExecutor): Promise<EffectExecution> {
        try {
            await Promise.all([...this.cleanup]);
            if (this.cleanupFailed) throw Error('HOOK_SANDBOX_CLEANUP_FAILED');
            await this.fire('PreToolUse', effect, undefined, signal);
            if (this.cleanupFailed) throw Error('HOOK_SANDBOX_CLEANUP_FAILED');
            // A script can finish before cancellation is noticed during native
            // teardown. Its valid output never authorizes a cancelled tool.
            signal.throwIfAborted();
        }
        catch (cause) {
            return { value: null, status: 'failed', executionState: 'failed', sideEffectState: 'none', error: { code: 'HOOK_PRE_DENIED', message: cause instanceof Error ? cause.message : 'HOOK_PRE_DENIED', retryable: false } };
        }
        let result: EffectExecution;
        try { result = await execute(effect, signal, observe); }
        catch (cause) { this.enqueuePost('PostToolUseFailure', effect, { value: null, status: 'failed', error: { code: 'TOOL_EXECUTION_FAILED', message: 'Tool execution failed.' } }); throw cause; }
        this.enqueuePost(result.error || result.status === 'failed' ? 'PostToolUseFailure' : 'PostToolUse', effect, result);
        // Observers must never postpone settlement past the tool's own deadline.
        return result;
    }
    private enqueuePost(event: HookEvent, effect: EffectRecord, result: EffectExecution): void {
        if (this.postController.signal.aborted) return;
        const signal = AbortSignal.any([this.postController.signal, AbortSignal.timeout(observerTimeoutMs())]);
        const saved = { id: effect.id, attemptId: effect.attemptId, attemptNo: effect.attemptNo, toolCallId: effect.toolCallId, input: structuredClone(effect.input) } as EffectRecord;
        const status: EffectExecution = { value: null, ...(result.status ? { status: result.status } : {}), ...(result.executionState ? { executionState: result.executionState } : {}), ...(result.sideEffectState ? { sideEffectState: result.sideEffectState } : {}), ...(result.error ? { error: { code: result.error.code, message: 'Tool execution failed.' } } : {}) };
        const pending = this.fire(event, saved, status, signal).catch(error => this.diagnostic(event, error, saved));
        this.pending.add(pending);
        void pending.finally(() => this.pending.delete(pending));
    }
    async dispose(): Promise<void> { this.postController.abort(); await Promise.allSettled([...this.activeHooks]); await Promise.all([...this.cleanup]); }
    private async diagnostic(event: HookEvent, error: unknown, effect?: EffectRecord): Promise<void> {
        if (!this.snapshot) return;
        try {
            await mkdir(this.journal, { recursive: true, mode: 0o700 });
            const receipt = { ...this.owner, event, effectId: effect?.id ?? null, attemptId: effect?.attemptId ?? null, attemptNo: effect?.attemptNo ?? null, definitionHash: this.snapshot.hash, status: 'diagnostic', error: error instanceof Error ? error.message.slice(0,500) : 'HOOK_FAILED', createdAt: new Date().toISOString() };
            await writeFile(join(this.journal, hash(JSON.stringify([this.owner,event,effect?.id,this.snapshot.hash,'configuration']))+'.json'), JSON.stringify(receipt), { flag:'wx', mode:0o600 });
        } catch { /* An observer cannot change the settled tool outcome, including on disk failure. */ }
    }
    private fire(event: HookEvent, effect: EffectRecord | undefined, result: EffectExecution | undefined, signal: AbortSignal): Promise<void> {
        const owned = event === 'Stop' ? signal : AbortSignal.any([signal, this.postController.signal]);
        const task = this.dispatch(event, effect, result, owned).catch(async error => {
            await this.diagnostic(event, error, effect);
            if (event === 'PreToolUse') throw error;
        });
        this.activeHooks.add(task);
        void task.then(() => this.activeHooks.delete(task), () => this.activeHooks.delete(task));
        return task;
    }
    private async dispatch(event: HookEvent, effect: EffectRecord | undefined, result: EffectExecution | undefined, signal: AbortSignal): Promise<void> {
        if (!this.snapshot)
            return;
        signal.throwIfAborted();
        const pre = event === 'PreToolUse';
        if (this.trusted?.enabled !== true || this.trusted.hash !== this.snapshot.hash || this.trusted.directory !== this.snapshot.directory)
            throw Error('HOOK_TRUST_REVOKED');
        const definitions = await checkHookDefinitions(this.snapshot), input = effect?.input as {
            name?: string;
            arguments?: unknown;
        } | undefined, name = input?.name ?? '';
        await mkdir(this.journal, { recursive: true, mode: 0o700 });
        for (const [index, d] of definitions.entries()) {
            if (d.event !== event || !hookMatches(d.matcher, effect ? name : event === 'SessionStart' ? this.source : ''))
                continue;
            const id = hash(JSON.stringify([this.owner, event, effect?.id ?? event, index, this.snapshot.hash, event === 'PostToolUseFailure' ? effect?.attemptId : undefined])), path = join(this.journal, id + '.json');
            const prior = await readFile(path, 'utf8').then(JSON.parse).catch(e => { if (e.code === 'ENOENT')
                return undefined; throw e; });
            if (prior) {
                if (pre && prior.status !== 'continue')
                    throw Error(['running', 'unknown'].includes(prior.status) ? 'HOOK_OUTCOME_UNKNOWN' : 'HOOK_PRE_DENIED');
                continue;
            }
            const receipt = { ...this.owner, event, effectId: effect?.id ?? null, attemptId: effect?.attemptId ?? null, attemptNo: effect?.attemptNo ?? null, definitionHash: this.snapshot.hash, index, status: 'running', createdAt: new Date().toISOString() };
            try {
                await writeFile(path, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
            }
            catch (e) {
                if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
                    if (pre)
                        throw Error('HOOK_OUTCOME_UNKNOWN');
                    continue;
                }
                throw e;
            }
            let error: string | undefined;
            try {
                const args = d.args.map(arg => { if (!arg.startsWith('@asset/'))
                    return arg; const path = arg.slice(7); if (!Object.hasOwn(d.assets, path))
                    throw Error('HOOK_ASSET_UNPINNED'); return join(this.snapshot!.directory, 'assets', path); });
                const payload = JSON.stringify(redacted({ hook_event_name: event, ...(event === 'SessionStart' ? { source: this.source } : {}), session_id: this.owner.runId, conversation_id: this.owner.conversationId, cwd: this.root, tool_name: name, tool_use_id: effect?.toolCallId, tool_input: hookToolInput(name, input?.arguments), effect_id: effect?.id, attempt_id: effect?.attemptId, attempt_no: effect?.attemptNo, definition_hash: this.snapshot.hash, ...(result ? { tool_response: { status: result.status, error: result.error?.code, executionState: result.executionState, sideEffectState: result.sideEffectState } } : {}) }));
                const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP'].includes(key)));
                let completed!: (result: ShellResult) => void;
                const processResult = new Promise<ShellResult>(resolve => { completed = resolve; });
                let confirmed = false;
                const command = runShell(d.command, args, { cwd: this.root, env, signal, timeoutMs: d.timeoutMs, maxOutputBytes: 32768, readOnlyWorkspace: true, isolatedHome: true, stdioTarget: true, readRoots: [this.snapshot.directory], allowedDomains: [], stdinData: payload, sealedCallerEnv: true, expectedIdentity: d.identity, beforeLaunch: async () => { await checkHookDefinitions(this.snapshot!); return d.identity; }, ...(pre ? { onProcessResult: (result: ShellResult) => { confirmed = true; completed(result); } } : {}) });
                // Pre decisions depend on confirmed stdin/exit/output, not on
                // slow ACL restoration after the script has already stopped.
                // Retain ownership of teardown through Stop/dispose; a failure
                // is diagnostic and blocks subsequent pre-hook operations.
                if (pre) {
                    const cleanup = command.then(() => {}, async () => {
                        if (!confirmed) return;
                        this.cleanupFailed = true;
                        await this.diagnostic(event, Error('HOOK_SANDBOX_CLEANUP_FAILED'), effect);
                    });
                    this.cleanup.add(cleanup);
                    void cleanup.then(() => this.cleanup.delete(cleanup));
                }
                const outcome = await (pre ? Promise.race([processResult, command]) : command);
                if (outcome.timedOut || outcome.aborted) throw Error('HOOK_OUTCOME_UNKNOWN');
                if (outcome.code !== 0 || outcome.truncated) throw Error('HOOK_COMMAND_FAILED');
                let raw: unknown;
                try { raw = outcome.stdout.trim() ? JSON.parse(outcome.stdout) : {} } catch { throw Error('HOOK_OUTPUT_INVALID') }
                const observer = z.object({ suppressOutput: z.boolean().optional() }).strict();
                const schema = pre ? observer.extend({ continue: z.boolean().optional(), decision: z.enum(['block', 'approve']).optional(), reason: z.string().max(2000).optional(), hookSpecificOutput: z.object({ hookEventName: z.literal('PreToolUse'), permissionDecision: z.enum(['deny', 'allow']), permissionDecisionReason: z.string().max(2000).optional() }).strict().optional() }) : observer;
                const parsed = schema.safeParse(raw);
                if (!parsed.success) throw Error('HOOK_OUTPUT_INVALID_OR_UNSUPPORTED');
                const output = parsed.data as { continue?: boolean; decision?: string; hookSpecificOutput?: { permissionDecision: string } };
                if (pre && (output.continue === false || output.decision === 'block' || output.hookSpecificOutput?.permissionDecision === 'deny')) throw Error('HOOK_PRE_DENIED');
            }
            catch (cause) {
                const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code) : '';
                const message = cause instanceof Error ? cause.message.slice(0, 500) : 'HOOK_COMMAND_FAILED';
                error = code === 'SHELL_STDIN_DELIVERY_UNKNOWN' || message === 'SHELL_STDIN_DELIVERY_UNKNOWN' ? 'HOOK_OUTCOME_UNKNOWN' : message;
            }
            const temp = path + '.' + randomUUID();
            await writeFile(temp, JSON.stringify({ ...receipt, status: error ? (pre ? (error === 'HOOK_OUTCOME_UNKNOWN' ? 'unknown' : 'deny') : 'diagnostic') : 'continue', ...(error ? { error } : {}), completedAt: new Date().toISOString() }), { mode: 0o600 });
            await replaceStateFile(temp, path);
            if (error && pre)
                throw Error(error);
        }
    }
}
