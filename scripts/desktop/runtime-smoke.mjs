import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { readRuntimeManifest, verifyRuntime } from '../../packages/desktop/src/runtime-manifest.mjs';
import { verifyNativeManifest } from './native-manifest.mjs';
import { verifyRuntimePlatform } from './verify-runtime-platform.mjs';

const execute = promisify(execFile);
const runtime = resolve(process.argv[2] ?? fileURLToPath(new URL('../../artifacts/desktop-runtime/pulse/', import.meta.url)));
const node = join(runtime, process.platform === 'win32' ? 'node.exe' : 'node');
if (!process.argv.includes('--bundled')) {
    // Outside the checkout, a missing dependency cannot fall back to the
    // developer's node_modules and hide an incomplete packaged closure.
    const isolated = await mkdtemp(join(tmpdir(), 'pulse-isolated-runtime-'));
    try {
        await cp(runtime, isolated, { recursive: true, dereference: false, verbatimSymlinks: true });
        const child = await execute(join(isolated, process.platform === 'win32' ? 'node.exe' : 'node'), [fileURLToPath(import.meta.url), isolated, '--bundled', ...process.argv.slice(3)], { timeout: 120000, maxBuffer: 1024 * 1024 });
        process.stdout.write(child.stdout); process.stderr.write(child.stderr);
    } finally { await rm(isolated, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
} else {
    const temporary = await mkdtemp(join(tmpdir(), 'pulse-runtime-feature-'));
    const modules = join(runtime, 'app/node_modules');
    const scope = name => createRequire(join(modules, `@hunterzhu/pulse-${name}/package.json`));
    const load = (name, file = 'dist/index.js') => import(pathToFileURL(join(modules, `@hunterzhu/pulse-${name}`, file)).href);
    const env = { ...process.env, PULSE_HOME: join(temporary, 'home'), PULSE_CONFIG: join(temporary, 'config.json'), PULSE_DATA_DIR: join(temporary, 'data'), PULSE_JARVIS_ENABLED: 'false' };
    try {
        const manifest = await readRuntimeManifest(runtime);
        await verifyRuntime(runtime, manifest, true);
        await verifyNativeManifest(runtime, process.platform, process.arch);
        const native = await verifyRuntimePlatform(runtime);
        const cli = join(runtime, 'app/cli.js');
        assert.ok((await execute(node, [cli, '--version'], { env })).stdout.includes(`Pulse v${manifest.version}`));
        await writeFile(env.PULSE_CONFIG, JSON.stringify({ providers: { mock: { provider: 'mock' } }, models: { mock: { provider: 'mock', modelCode: 'mock' } }, activeModel: 'mock', approvalMode: 'auto', allowNetwork: false }));
        const assessment = JSON.stringify([{ status: 'accepted', criteria: [{ criterionId: 'criterion-1', status: 'passed', evidenceRefs: ['result-1'], rationale: 'The packaged output is present.' }] }]);
        const task = await execute(node, [cli, 'run', 'say hello', '--mock-response', 'packaged runtime ok', '--mock-task-assessment', assessment, '--cwd', temporary], { env, timeout: 30000 });
        assert.ok(task.stdout.includes('packaged runtime ok'));
        const { ToolRegistry } = await load('tool-sdk');
        const { createDocumentTools } = await load('adapters');
        const registry = new ToolRegistry({ workspaceRoots: [temporary], allowNetwork: false });
        for (const definition of createDocumentTools(temporary)) registry.register(definition);
        await writeFile(join(temporary, 'fixture.pdf'), await readFile(new URL('../../tests/fixtures/document-tools.pdf', import.meta.url)));
        const pdf = await registry.execute('document.pdf.read', { path: 'fixture.pdf' }, new AbortController().signal);
        assert.ok(pdf.text.includes('Pulse PDF fixture text'));
        const ExcelJS = scope('adapters')('exceljs'), workbook = new ExcelJS.Workbook();
        workbook.addWorksheet('Smoke').addRow(['Preserved', 42]);
        await workbook.xlsx.writeFile(join(temporary, 'fixture.xlsx'));
        const sheet = await registry.execute('document.xlsx.inspect', { path: 'fixture.xlsx', sheet: 'Smoke' }, new AbortController().signal);
        assert.deepEqual(sheet.worksheets[0].preview[0].cells, ['Preserved', 42]);
        const mammothRequire = createRequire(scope('adapters').resolve('mammoth'));
        const JSZip = mammothRequire('jszip'), zip = new JSZip();
        zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
        zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Preserved DOCX</w:t></w:r></w:p></w:body></w:document>');
        const { extractDocxText } = await load('adapters', 'dist/documents/docx.js');
        assert.ok((await extractDocxText(await zip.generateAsync({ type: 'nodebuffer' }), new AbortController().signal)).includes('Preserved DOCX'));
        const canvasRequire = createRequire(scope('adapters').resolve('pdfjs-dist/legacy/build/pdf.mjs'));
        assert.equal(canvasRequire('@napi-rs/canvas').createCanvas(2, 2).toBuffer('image/png').toString('ascii', 1, 4), 'PNG');
        const pty = scope('server')('node-pty');
        const shell = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/cmd.exe') : '/bin/sh';
        await new Promise((accept, reject) => {
            const child = pty.spawn(shell, process.platform === 'win32' ? ['/d', '/c', 'echo PULSE_PTY_OK'] : ['-c', 'printf PULSE_PTY_OK'], { cwd: temporary, env });
            let output = '';
            const timer = setTimeout(() => { child.kill(); reject(new Error('Packaged PTY timeout')); }, 10000);
            child.onData(text => { output += text; });
            child.onExit(({ exitCode }) => { clearTimeout(timer); try { assert.equal(exitCode, 0); assert.ok(output.includes('PULSE_PTY_OK')); accept(); } catch (error) { reject(error); } });
        });
        if (process.argv.includes('--native-helper')) {
            const { DesktopBackend } = await load('server', 'dist/automation/desktop.js'), desktop = new DesktopBackend();
            try { assert.equal((await desktop.call('hello', {})).protocolVersion, 1); }
            finally { await desktop.close(); }
        }
        console.log(JSON.stringify({ ok: true, version: manifest.version, bundledNode: process.execPath, nativeBinaries: native.binaries.length, cliTask: true, pdf: true, xlsx: true, docxWorker: true, canvas: true, nativePty: true, nativeHelper: process.argv.includes('--native-helper') }));
    } finally { await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
