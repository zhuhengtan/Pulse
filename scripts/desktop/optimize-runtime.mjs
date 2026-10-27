import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

const entries = async directory => readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
});
const contains = (root, path) => path === root || path.startsWith(root + sep);

async function packages(directory, result = new Map()) {
    for (const entry of await entries(directory)) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = join(directory, entry.name);
        if (entry.name.startsWith('@')) { await packages(path, result); continue; }
        const manifest = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
        result.set(path, { path, manifest });
        await packages(join(path, 'node_modules'), result);
    }
    return result;
}

// Resolve at package boundaries, including peer and optional dependencies.
// Do not introduce links: Windows installations must work without symlink privileges.
function resolvePackage(from, name, nodes, root, ignored) {
    for (let directory = from; contains(root, directory); directory = dirname(directory)) {
        const value = nodes.get(join(directory, 'node_modules', name));
        if (value && value !== ignored) return value;
        if (directory === root) break;
    }
}

async function fingerprint(directory) {
    const digest = createHash('sha256');
    async function walk(path) {
        for (const entry of (await entries(path)).sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.name === 'node_modules') continue;
            const file = join(path, entry.name), info = await lstat(file);
            digest.update(JSON.stringify([relative(directory, file), info.mode & 0o777, entry.isDirectory() ? 0 : info.size, entry.isSymbolicLink()]));
            if (entry.isDirectory()) await walk(file);
            else if (entry.isSymbolicLink()) digest.update(await readlink(file));
            else digest.update(await readFile(file));
        }
    }
    await walk(directory);
    return digest.digest('hex');
}

async function deduplicate(root) {
    const nodes = await packages(join(root, 'node_modules'));
    for (const node of nodes.values()) {
        node.content = await fingerprint(node.path);
        node.edges = Object.keys({ ...node.manifest.dependencies, ...node.manifest.optionalDependencies, ...node.manifest.peerDependencies }).sort()
            .map(name => [name, resolvePackage(node.path, name, nodes, root)?.path]);
    }
    // Refine equivalence classes until dependencies (including cycles/peers)
    // are equivalent, not just package names and versions or matching files.
    let classes = new Map([...nodes].map(([path, node]) => [path, node.content]));
    for (let iteration = 0; iteration <= nodes.size; iteration++) {
        const groups = new Map(), next = new Map();
        for (const [path, node] of nodes) {
            const key = JSON.stringify([classes.get(path), node.edges.map(([name, target]) => [name, target ? classes.get(target) : null])]);
            if (!groups.has(key)) groups.set(key, groups.size);
            next.set(path, groups.get(key));
        }
        const stable = new Set(classes.values()).size === groups.size;
        classes = next;
        if (stable) break;
        assert.ok(iteration < nodes.size, 'Dependency equivalence did not converge');
    }
    const live = new Map(nodes), removed = [];
    for (const node of [...nodes.values()].sort((a, b) => a.path.split(sep).length - b.path.split(sep).length)) {
        if (!live.has(node.path)) continue;
        const moduleDirectory = node.manifest.name?.startsWith('@') ? dirname(dirname(node.path)) : dirname(node.path);
        const ancestor = resolvePackage(dirname(moduleDirectory), node.manifest.name, live, root, node);
        if (!ancestor || ancestor === node || classes.get(ancestor.path) !== classes.get(node.path)) continue;
        await rm(node.path, { recursive: true });
        removed.push(relative(root, node.path));
        for (const path of live.keys()) if (contains(node.path, path)) live.delete(path);
    }
    for (const node of live.values()) {
        for (const [name, target] of node.edges) {
            const actual = resolvePackage(node.path, name, live, root)?.path;
            assert.equal(actual ? classes.get(actual) : undefined, target ? classes.get(target) : undefined,
                `Dependency resolution changed: ${relative(root, node.path)} -> ${name}`);
        }
    }
    return { packagesBefore: nodes.size, packagesAfter: live.size, removed };
}

export async function optimizeRuntime(root, platform = process.platform, arch = process.arch) {
    assert.ok(['darwin', 'win32', 'linux'].includes(platform), 'Unsupported desktop platform');
    assert.ok(['arm64', 'x64'].includes(arch), 'Unsupported desktop architecture');
    const report = { platform, arch, removed: [], deduplication: undefined };
    async function remove(path) {
        if (!await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error; })) return;
        await rm(path, { recursive: true, force: true });
        report.removed.push(relative(root, path));
    }
    async function select(directory, target) {
        for (const entry of await entries(directory)) if (entry.isDirectory() && entry.name !== target) await remove(join(directory, entry.name));
    }
    for (const node of (await packages(join(root, 'app/node_modules'))).values()) {
        const { path, manifest } = node;
        if (manifest.name === 'node-pty') {
            await select(join(path, 'prebuilds'), `${platform}-${arch}`);
            // node-pty 1.1.0 publishes its Darwin spawn-helper with mode 0644.
            // Seal executable permissions into the bundle before hashing/signing,
            // without relying on a prior H5 terminal launch to repair the file.
            if (platform === 'darwin') for (const directory of ['build/Release', 'build/Debug', `prebuilds/${platform}-${arch}`]) {
                const helper = join(path, directory, 'spawn-helper');
                const info = await lstat(helper).catch(error => { if (error.code !== 'ENOENT') throw error; });
                if (info?.isFile()) await chmod(helper, 0o755);
            }
            if (platform !== 'win32') {
                await remove(join(path, 'deps/winpty'));
                await remove(join(path, 'third_party/conpty'));
            } else {
                for (const version of await entries(join(path, 'third_party/conpty'))) {
                    if (version.isDirectory()) await select(join(path, 'third_party/conpty', version.name), `win10-${arch}`);
                }
            }
            for (const entry of await entries(join(path, 'prebuilds', `${platform}-${arch}`))) {
                if (entry.name.endsWith('.pdb')) await remove(join(path, 'prebuilds', `${platform}-${arch}`, entry.name));
            }
        }
        if (manifest.name === '@hunterzhu/pulse-server') {
            await select(join(path, 'native'), `${platform}-${arch}`);
            const native = join(path, 'native', `${platform}-${arch}`);
            const file = join(native, 'manifest.json');
            const helper = await readFile(file, 'utf8').then(JSON.parse).catch(error => { if (error.code !== 'ENOENT') throw error; });
            for (const name of ['windows.ps1', 'linux.py']) {
                if (name === (platform === 'win32' ? 'windows.ps1' : platform === 'linux' ? 'linux.py' : '')) continue;
                await remove(join(native, name));
                if (helper?.hashes) delete helper.hashes[name];
            }
            if (helper) await writeFile(file, JSON.stringify(helper, null, 2) + '\n');
        }
        if (manifest.name === '@anthropic-ai/sandbox-runtime') {
            for (const [directory, system] of [['srt-win', 'win32'], ['seccomp', 'linux']]) {
                const vendor = join(path, 'vendor', directory);
                if (platform !== system) await remove(vendor);
                else await select(vendor, arch);
            }
        }
        if (manifest.name === '@hunterzhu/pulse-adapters' && platform !== 'win32') await remove(join(path, 'dist/native'));
        // External debugger maps are not runtime modules. Keep Pulse's own
        // maps, package entry points, workers, fonts, declarations and licenses.
        if (!manifest.name?.startsWith('@hunterzhu/')) {
            async function maps(directory) {
                for (const entry of await entries(directory)) {
                    if (entry.name === 'node_modules') continue;
                    const file = join(directory, entry.name);
                    if (entry.isDirectory()) await maps(file);
                    else if (/\.(?:[cm]?js|d\.ts)\.map$/.test(entry.name)) await remove(file);
                }
            }
            await maps(path);
        }
    }
    for (const suffix of platform === 'win32' ? ['sh'] : ['ps1']) {
        for (const name of ['install', 'uninstall']) await remove(join(root, `${name}.${suffix}`));
    }
    report.deduplication = await deduplicate(join(root, 'app'));
    return report;
}
