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
it('a sealed hook child keeps sandbox runtime settings and drops injected host markers', async () => {
    const previous = { AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID, SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, KUBECONFIG: process.env.KUBECONFIG };
    process.env.AWS_ACCESS_KEY_ID = 'fake-aws-marker';
    process.env.SSH_AUTH_SOCK = '/tmp/fake-agent-marker';
    process.env.KUBECONFIG = '/tmp/fake-kube-marker';
    const root = await mkdtemp(join(tmpdir(), 'pulse-hook-sealed-'));
    roots.push(root);
    try {
        const result = await runShell(process.execPath, ['-e', `process.stdout.write(JSON.stringify({aws:process.env.AWS_ACCESS_KEY_ID??null,ssh:process.env.SSH_AUTH_SOCK??null,kube:process.env.KUBECONFIG??null,sandbox:process.env.SANDBOX_RUNTIME??null,home:process.env.HOME??''}))`], { cwd: root, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', LANG: process.env.LANG ?? 'C' }, readOnlyWorkspace: true, isolatedHome: true, stdioTarget: true, allowedDomains: [], timeoutMs: 20000, stdinData: '{}', sealedCallerEnv: true });
        expect(result.code).toBe(0);
        const child = JSON.parse(result.stdout) as { aws: string | null; ssh: string | null; kube: string | null; sandbox: string | null; home: string };
        expect(child).toMatchObject({ aws: null, ssh: null, kube: null, sandbox: '1' });
        expect(child.home).toContain('pulse-shell-');
        expect(child.home).not.toBe(process.env.HOME);
    } finally {
        for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
}, nativeTimeout(1, 30000));
