import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { desktopDownloadManifest } from '../release/desktop-assets.mjs';
const response = await fetch('https://api.github.com/repos/zhuhengtan/Pulse/releases/latest', { headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
if (!response.ok && response.status !== 404) throw new Error(`RELEASE_METADATA_UNAVAILABLE:${response.status}`);
const manifest = desktopDownloadManifest(response.ok ? await response.json() : undefined);
await writeFile(fileURLToPath(new URL('../../site/downloads.json', import.meta.url)), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.version ? `Prepared desktop download links for ${manifest.version}.` : 'No complete desktop release yet; the product page will show release progress.');
