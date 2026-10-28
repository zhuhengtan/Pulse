import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, relative, isAbsolute } from 'node:path';
import { desktopDownloadManifest, desktopAssets } from '../release/desktop-assets.mjs';
const root = fileURLToPath(new URL('../../site/', import.meta.url));
const html = await readFile(resolve(root, 'index.html'), 'utf8');
for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
  const link = match[1]; if (/^https:\/\//.test(link) || link === './') continue;
  if (/^[a-z]+:|^\/\//i.test(link)) throw new Error(`SITE_LINK_SCHEME_INVALID:${link}`);
  const path = resolve(root, link), rel = relative(root, path);
  if (isAbsolute(rel) || rel.startsWith('..')) throw new Error(`SITE_LINK_OUTSIDE_ROOT:${link}`);
  await access(path);
}
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
if (new Set(ids).size !== ids.length) throw new Error('SITE_DUPLICATE_ANCHOR');
for (const [, target] of html.matchAll(/href="#([^"]+)"/g)) if (!ids.includes(target)) throw new Error(`SITE_ANCHOR_MISSING:${target}`);
for (const { platform } of desktopAssets) if (!html.includes(`data-download="${platform}"`)) throw new Error(`SITE_DOWNLOAD_MISSING:${platform}`);
if (!html.includes('PolyForm Noncommercial') || !html.includes('<noscript>')) throw new Error('SITE_REQUIRED_INFORMATION_MISSING');
const manifest = JSON.parse(await readFile(resolve(root, 'downloads.json'), 'utf8'));
if (manifest.version !== null) {
  const tag = manifest.releaseUrl.split('/').at(-1);
  const normalized = desktopDownloadManifest({ tag_name: tag, html_url: manifest.releaseUrl, assets: [...manifest.assets.map(asset => ({ ...asset, state: 'uploaded', browser_download_url: asset.url })), { name: 'pulse-desktop-SHA256SUMS.txt', state: 'uploaded', size: 1 }] });
  if (JSON.stringify(normalized) !== JSON.stringify(manifest)) throw new Error('SITE_DOWNLOAD_MANIFEST_INVALID');
}
console.log('Product site: local assets, anchors, license and download manifest verified.');
