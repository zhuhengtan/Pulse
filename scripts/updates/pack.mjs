import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
import { componentSchema, protocols } from '../../packages/server/dist/updates/contracts.js';
import { sha256, trustedKeys, verifyFiles } from '../../packages/server/dist/updates/security.js';
import { parseChangelog, changelogPaths } from '../release/changelog.mjs';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('../../packages/server/package.json', import.meta.url));
const { ZipFile } = require('yazl');
export function signEnvelope(value, privateKey, keyId) { const payload = JSON.stringify(value); return { keyId, payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') }; }
export async function packComponent({ component, source, destination, version, platform = 'any', arch = 'any', baseUrl, keyId, privateKey, shell = '0.8.0', backend = '0.8.0', chromium = 120, notes = '' }) {
  const files = {}, zip = new ZipFile();
  const archiveName = `pulse-${component}-${version}-${platform}-${arch}.zip`, archive = join(destination, archiveName);
  await mkdir(destination, { recursive: true });
  const output = pipeline(zip.outputStream, createWriteStream(archive, { flags: 'wx' }));
  const root = await realpath(source);
  async function walk(directory) {
    for (const item of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (['.DS_Store', 'Thumbs.db', 'desktop.ini'].includes(item.name) || item.name.startsWith('._')) continue;
      const path = join(directory, item.name), name = relative(source, path).split(sep).join('/'), info = await lstat(path);
      if (item.isDirectory()) { zip.addEmptyDirectory(name); await walk(path); }
      else if (item.isSymbolicLink()) {
        const link = await readlink(path), rel = relative(root, await realpath(path));
        if (isAbsolute(link) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('UPDATE_PATH_INVALID');
        files[name] = { link }; zip.addBuffer(Buffer.from(link), name, { mode: 0o120777 });
      } else if (item.isFile()) { files[name] = { bytes: info.size, sha256: await sha256(path), mode: info.mode & 0o777 }; zip.addFile(path, name, { mode: 0o100000 | info.mode & 0o777 }); }
      else throw new Error('UPDATE_FILE_TYPE_INVALID');
    }
  }
  await walk(source); zip.end(); await output;
  const manifest = componentSchema.parse({ schema: 1, component, version, platform, arch, notes,
    requires: { ...protocols, shell, backend: component === 'frontend' ? backend : undefined, chromium: component === 'frontend' ? chromium : undefined },
    data: { min: 1, max: 1, writes: 1, reversible: true },
    artifact: { url: new URL(archiveName, baseUrl).href, bytes: (await lstat(archive)).size, sha256: await sha256(archive) }, files,
  });
  await verifyFiles(source, manifest);
  const name = `${archiveName}.manifest.json`, envelope = signEnvelope(manifest, privateKey, keyId);
  await writeFile(join(destination, name), JSON.stringify(envelope));
  return { component, version, platform, arch, url: new URL(name, baseUrl).href, sha256: await sha256(join(destination, name)) };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const component = process.argv[2];
  if (!['backend', 'frontend', 'shell'].includes(component)) throw new Error('Usage: node scripts/updates/pack.mjs backend|frontend|shell [source-directory-or-installer]');
  const keyId = process.env.PULSE_UPDATE_KEY_ID, keyFile = process.env.PULSE_UPDATE_PRIVATE_KEY_FILE;
  if (!keyId || !keyFile || !trustedKeys[keyId]) throw new Error('UPDATE_SIGNING_KEY_REQUIRED');
  const privateKey = createPrivateKey(await readFile(keyFile));
  if (privateKey.asymmetricKeyType !== 'ed25519' || createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString() !== trustedKeys[keyId]) throw new Error('UPDATE_SIGNING_KEY_INVALID');
  const packageName = component === 'shell' ? 'desktop' : component === 'backend' ? 'cli' : 'web';
  const version = JSON.parse(await readFile(join(repo, `packages/${packageName}/package.json`))).version;
  const tag = `${component}-v${version}`, destination = join(repo, 'artifacts/updates');
  if (process.env.GITHUB_REF_NAME && process.env.GITHUB_REF_NAME !== tag) throw new Error('UPDATE_TAG_VERSION_MISMATCH');
  let notes;
  if (component === 'backend') {
    const entries = parseChangelog(await readFile(changelogPaths.zh, 'utf8'), await readFile(changelogPaths.en, 'utf8')).get(version);
    if (!entries?.length) throw new Error('UPDATE_RELEASE_NOTES_REQUIRED');
    notes = entries.map(entry => `${entry.zh}\n${entry.en}`).join('\n\n');
  } else notes = await readFile(join(repo, 'docs', 'component-releases', component, version + '.md'), 'utf8').catch(() => { throw new Error('UPDATE_RELEASE_NOTES_REQUIRED:docs/component-releases/' + component + '/' + version + '.md'); });
  const baseUrl = `https://github.com/zhuhengtan/Pulse/releases/download/${tag}/`;
  await mkdir(destination, { recursive: true });
  let reference;
  if (component === 'shell') {
    const source = process.argv[3]; if (!source) throw new Error('SHELL_INSTALLER_REQUIRED');
    const manifest = componentSchema.parse({ schema: 1, component, version, platform: process.platform, arch: process.arch, notes, requires: { ...protocols }, data: { min: 1, max: 1, writes: 1, reversible: true }, artifact: { url: new URL(basename(source), baseUrl).href, bytes: (await lstat(source)).size, sha256: await sha256(source) }, files: {} });
    const name = `pulse-shell-${version}-${process.platform}-${process.arch}.manifest.json`;
    await writeFile(join(destination, name), JSON.stringify(signEnvelope(manifest, privateKey, keyId)));
    reference = { component, version, platform: process.platform, arch: process.arch, url: new URL(name, baseUrl).href, sha256: await sha256(join(destination, name)) };
  } else reference = await packComponent({ component, source: process.argv[3] ?? join(repo, component === 'frontend' ? 'packages/web/dist' : 'artifacts/desktop-runtime/pulse'), destination, version, platform: component === 'backend' ? process.platform : 'any', arch: component === 'backend' ? process.arch : 'any', baseUrl, keyId, privateKey, notes });
  await writeFile(join(destination, `${component}-${reference.platform}-${reference.arch}.ref.json`), JSON.stringify(reference));
  console.log(`Created signed ${component} update ${version} (${reference.platform}/${reference.arch}).`);
}
