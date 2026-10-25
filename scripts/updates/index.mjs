import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { componentSchema, indexSchema } from '../../packages/server/dist/updates/contracts.js';
import { fetchBytes, sha256, signedValue, trustedKeys } from '../../packages/server/dist/updates/security.js';

const repository = 'https://api.github.com/repos/zhuhengtan/Pulse';
const headers = { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const releases = [];
for (let page = 1; ; page++) {
  const response = await fetch(`${repository}/releases?per_page=100&page=${page}`, { headers });
  if (!response.ok) throw new Error('UPDATE_RELEASE_LIST_UNAVAILABLE');
  const batch = await response.json(); releases.push(...batch);
  if (batch.length < 100) break;
}
const refs = [];
for (const release of releases) {
  if (release.draft || release.prerelease || !/^(shell|backend|frontend)-v\d+\.\d+\.\d+$/.test(release.tag_name)) continue;
  const component = release.tag_name.split('-v')[0], version = release.tag_name.split('-v')[1];
  const prefix = `https://github.com/zhuhengtan/Pulse/releases/download/${release.tag_name}/`;
  const assets = release.assets.filter(asset => asset.state === 'uploaded');
  const manifests = assets.filter(asset => asset.name.endsWith('.manifest.json'));
  if (!manifests.length) throw new Error('UPDATE_RELEASE_INCOMPLETE');
  for (const asset of manifests) {
    if (asset.browser_download_url !== prefix + asset.name) throw new Error('UPDATE_RELEASE_URL_INVALID');
    const bytes = await fetchBytes(asset.browser_download_url, 32 * 1024 ** 2);
    const manifest = signedValue(JSON.parse(bytes), componentSchema).value;
    const payload = assets.find(item => prefix + item.name === manifest.artifact.url && item.size === manifest.artifact.bytes);
    if (!payload || manifest.component !== component || manifest.version !== version) throw new Error('UPDATE_RELEASE_INCOMPLETE');
    const { createHash } = await import('node:crypto');
    refs.push({ component, version, platform: manifest.platform, arch: manifest.arch, url: asset.browser_download_url, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
const keyId = process.env.PULSE_UPDATE_KEY_ID, path = process.env.PULSE_UPDATE_PRIVATE_KEY_FILE;
if (!keyId || !path || !trustedKeys[keyId]) throw new Error('UPDATE_SIGNING_KEY_REQUIRED');
const key = createPrivateKey(await readFile(path));
if (createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString() !== trustedKeys[keyId]) throw new Error('UPDATE_SIGNING_KEY_MISMATCH');
const value = indexSchema.parse({ schema: 1, sequence: Date.now(), expiresAt: new Date(Date.now() + 90 * 86400000).toISOString(), releases: refs });
const payload = JSON.stringify(value), envelope = { keyId, payload, signature: sign(null, Buffer.from(payload), key).toString('base64') };
const directory = fileURLToPath(new URL('../../site/updates/', import.meta.url));
await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'stable.json'), JSON.stringify(envelope));
console.log(`Prepared signed update index with ${refs.length} component releases.`);
