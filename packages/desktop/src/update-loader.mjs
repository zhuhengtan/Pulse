import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { verifyRuntime } from './runtime-manifest.mjs';
import { createRequire } from 'node:module';
const trustedKeys = createRequire(import.meta.url)('./update-keys.json');
const verifiedComponents = new Map();
const compare = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
function verifySigned(directory, id, files, reuse) {
    const key = `${id}\0${directory}`;
    if (!reuse) verifiedComponents.delete(key);
    let pending = verifiedComponents.get(key);
    if (!pending) {
        pending = verifyRuntime(directory, { files, critical: Object.keys(files) }, true).catch(error => { verifiedComponents.delete(key); throw error; });
        verifiedComponents.set(key, pending);
    }
    return pending;
}
export async function verifySelectedFile(directory, files, name) {
    if (!files?.[name]) throw new Error('UPDATE_FILE_INVALID');
    await verifyRuntime(directory, { files, critical: [name] }, false);
}
async function selectedComponent(root, dataDir, shellVersion, chromium, component, requestedId, verificationKeys = trustedKeys, reuseVerification = false) {
    const scope = createHash('sha256').update(resolve(dataDir)).digest('hex').slice(0, 32);
    const state = await readFile(join(root, 'updates/scopes', scope + '.json'), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    let item = state?.active?.[component];
    if (requestedId) {
        if (!/^frontend-\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(requestedId)) throw new Error('UPDATE_SELECTION_INVALID');
        const directory = join(resolve(root), 'updates/components', requestedId);
        const envelope = JSON.parse(await readFile(join(directory, 'component.json'), 'utf8'));
        const manifest = JSON.parse(envelope.payload), { files, ...metadata } = manifest;
        item = { directory, manifest: metadata };
    }
    if (!item) return undefined;
    const id = `${component}-${item.manifest.version}-${item.manifest.artifact.sha256.slice(0, 16)}`;
    if (!/^(backend|frontend)-\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(id) || resolve(item.directory) !== join(resolve(root), 'updates/components', id)) throw new Error('UPDATE_SELECTION_INVALID');
    const envelope = JSON.parse(await readFile(join(item.directory, 'component.json'), 'utf8'));
    const key = verificationKeys[envelope.keyId];
    if (!key || createPublicKey(key).asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(envelope.payload), key, Buffer.from(envelope.signature, 'base64'))) throw new Error('UPDATE_SIGNATURE_INVALID');
    const manifest = JSON.parse(envelope.payload), { files, ...metadata } = manifest;
    if (JSON.stringify(metadata) !== JSON.stringify(item.manifest) || manifest.schema !== 1 || manifest.component !== component || manifest.platform !== 'any' && manifest.platform !== process.platform || manifest.arch !== 'any' && manifest.arch !== process.arch) throw new Error('UPDATE_SELECTION_INVALID');
    const shellKnown = /^\d+\.\d+\.\d+$/.test(String(shellVersion ?? ''));
    if (manifest.requires.shell && (!shellKnown || compare(shellVersion, manifest.requires.shell) < 0) || manifest.requires.chromium && (!Number.isInteger(chromium) || chromium < manifest.requires.chromium)) throw new Error('UPDATE_SHELL_REQUIRED');
    if (Object.entries(manifest.requires).some(([name, value]) => ['http', 'events', 'bridge', 'nativeBrowser', 'reader'].includes(name) && value !== 1)) throw new Error('UPDATE_PROTOCOL_INCOMPATIBLE');
    const critical = component === 'frontend' ? ['index.html'] : [process.platform === 'win32' ? 'node.exe' : 'node', 'desktop-runtime.json', 'app/node_modules/@hunterzhu/pulse-cli/dist/bin.js', 'app/node_modules/@hunterzhu/pulse-server/dist/updates/reader.js', 'app/node_modules/@hunterzhu/pulse-server/dist/updates/coordinator.js'];
    if (critical.some(name => !files[name])) throw new Error('UPDATE_COMPONENT_INCOMPLETE');
    await verifySigned(item.directory, id, files, reuseVerification);
    return { directory: item.directory, id, version: manifest.version, files };
}

export async function selectedBackend(root, dataDir, shellVersion, chromium, full = false) { return (await selectedComponent(root, dataDir, shellVersion, chromium, 'backend', undefined, undefined, !full))?.directory; }
export async function selectedFrontend(root, dataDir, shellVersion, chromium, id, verificationKeys) { return selectedComponent(root, dataDir, shellVersion, chromium, 'frontend', id, verificationKeys, true); }
