import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, readlink, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export const manifestName = 'desktop-runtime.json';
export async function fileDigest(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}
export function runtimeFile(root, name) {
    const path = resolve(root, name), rel = relative(resolve(root), path);
    if (!rel || rel.startsWith('..' + sep) || rel === '..' || resolve(name) === name) throw new Error('INVALID_RUNTIME_MANIFEST');
    return path;
}
export async function writeRuntimeManifest(root, version, platform = process.platform, arch = process.arch, components = {}) {
    const files = {};
    async function walk(directory) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            if (['.DS_Store', 'Thumbs.db', 'desktop.ini', '.git', '.svn'].includes(item.name) || item.name.startsWith('._')) continue;
            const path = join(directory, item.name), name = relative(root, path).split(sep).join('/');
            if (name === manifestName) continue;
            if (item.isSymbolicLink()) {
                const link = await readlink(path), rel = relative(await realpath(root), await realpath(path));
                if (isAbsolute(link) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('RUNTIME_SYMLINK_NOT_ALLOWED');
                files[name] = { link }; continue;
            }
            if (item.isDirectory()) await walk(path);
            else if (item.isFile()) files[name] = { bytes: (await lstat(path)).size, sha256: await fileDigest(path) };
        }
    }
    await walk(root);
    const critical = [platform === 'win32' ? 'node.exe' : 'node', 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js', 'app/node_modules/@hunterzhu/pulse-cli/dist/config.js', 'app/node_modules/@hunterzhu/pulse-server/dist/index.js', 'app/node_modules/@hunterzhu/pulse-server/dist/web/index.html'];
    if (components.browserExecutable) critical.push(components.browserExecutable);
    for (const name of critical) if (!files[name]) throw new Error('RUNTIME_COMPONENT_MISSING:' + name);
    const buildId = createHash('sha256').update(JSON.stringify({ version, platform, arch, files, components })).digest('hex');
    const manifest = { schema: 1, version, platform, arch, buildId, files, critical, ...components };
    await writeFile(join(root, manifestName), JSON.stringify(manifest), { mode: 0o600 });
    return manifest;
}
export async function readRuntimeManifest(root, platform = process.platform, arch = process.arch) {
    const value = JSON.parse(await readFile(join(root, manifestName), 'utf8'));
    if (value.schema !== 1 || !/^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/.test(value.version) || !/^[a-f0-9]{64}$/.test(value.buildId) || !value.files || !Array.isArray(value.critical) || !value.critical.length) throw new Error('INVALID_RUNTIME_MANIFEST');
    if (value.platform !== platform || value.arch !== arch) throw new Error('RUNTIME_PLATFORM_MISMATCH');
    return value;
}
export async function verifyRuntime(root, manifest, full = false) {
    for (const name of full ? Object.keys(manifest.files) : manifest.critical) {
        const file = runtimeFile(root, name), info = await lstat(file);
        const rel = relative(await realpath(root), await realpath(file));
        if (rel === '..' || rel.startsWith('..' + sep)) throw new Error('RUNTIME_FILE_CHANGED:' + name);
        if (manifest.files[name]?.link !== undefined) { if (!info.isSymbolicLink() || await readlink(file) !== manifest.files[name].link) throw new Error('RUNTIME_FILE_CHANGED:' + name); continue; }
        if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.files[name]?.bytes || await fileDigest(file) !== manifest.files[name]?.sha256) throw new Error('RUNTIME_FILE_CHANGED:' + name);
    }
}
