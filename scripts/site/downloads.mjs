import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { desktopDownloadManifest } from '../release/desktop-assets.mjs';
let manifest = desktopDownloadManifest(undefined);
for (let page = 1; ; page++) {
  const response = await fetch(`https://api.github.com/repos/zhuhengtan/Pulse/releases?per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json', ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!response.ok && response.status !== 404) throw new Error(`RELEASE_METADATA_UNAVAILABLE:${response.status}`);
  const releases = response.ok ? await response.json() : [];
  const desktop = releases.map(desktopDownloadManifest).find(item => item.version);
  if (desktop) { manifest = desktop; break; }
  if (releases.length < 100) break;
}
await writeFile(fileURLToPath(new URL('../../site/downloads.json', import.meta.url)), JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.version ? `Prepared desktop download links for ${manifest.version}.` : 'No complete desktop release yet; the product page will show release progress.');
