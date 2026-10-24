import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { requiredDesktopFiles } from './desktop-assets.mjs';
const root = process.argv[2] ?? 'artifacts/desktop';
const lines = [];
for (const name of requiredDesktopFiles) {
  const path = join(root, name), info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`DESKTOP_RELEASE_ASSET_INVALID:${name}`);
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  lines.push(`${hash}  ${name}`);
}
await writeFile(join(root, 'pulse-desktop-SHA256SUMS.txt'), lines.join('\n') + '\n');
console.log(`Verified ${lines.length} desktop installers and archives; SHA-256 checksums generated.`);
