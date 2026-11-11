import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rm, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createRequire } from 'node:module';
import { buildWindowsSandbox } from './build-srt-win.mjs';
import { replaceInstalledDirectory } from './replace-installed-directory.mjs';
const require = createRequire(new URL('../../packages/desktop/package.json', import.meta.url));
const { x } = require('tar');
const root = fileURLToPath(new URL('../../', import.meta.url));
const arch = process.env.PULSE_DESKTOP_ARCH ?? process.arch;
const platform = process.env.PULSE_DESKTOP_PLATFORM ?? process.platform;
const targets = { 'darwin-arm64': 'aarch64-apple-darwin', 'win32-x64': 'x86_64-pc-windows-msvc', 'linux-x64': 'x86_64-unknown-linux-gnu' };
const target = targets[`${platform}-${arch}`]; if (!target) throw new Error(`Unsupported native target: ${platform}/${arch}`);
const destination = process.env.PULSE_DESKTOP_OUTPUT_DIR ? resolve(process.env.PULSE_DESKTOP_OUTPUT_DIR) : resolve(root, `packages/server/native/${platform}-${arch}`);
const version = '1.2.0', archive = `agent-desktop-v${version}-${target}.tar.gz`;
const base = `https://github.com/vercel-labs/agent-desktop/releases/download/v${version}`;
async function get(url) { const response = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`Download failed: ${response.status}`); return Buffer.from(await response.arrayBuffer()); }
const pinned = { 'darwin-arm64': '219813428bb1ad8decae172faed05c5964a2415170df402e2786ccfa6452ba82', 'win32-x64': 'a4199f741a441cedd349bf56c5eba01783b1261258b498efeb7ec9945220c3e8', 'linux-x64': '591ae7f4a38479dc045df97e27447c0c8b530441730ab6b990e27c813162af44' };
const expected = pinned[`${platform}-${arch}`];
const bytes = await get(`${base}/${archive}`);
if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Agent desktop checksum mismatch');
const temporary = destination + '.install'; await rm(temporary, { recursive: true, force: true }); await mkdir(temporary, { recursive: true });
try {
  await pipeline(Readable.from(bytes), x({ cwd: temporary, strict: true, filter: (path, entry) => !path.startsWith('/') && !path.split('/').includes('..') && ['File','Directory'].includes(entry.type) }));
  const executable = `agent-desktop${platform === 'win32' ? '.exe' : ''}`;
  await chmod(join(temporary, executable), 0o755);
  const license = await get(`https://raw.githubusercontent.com/vercel-labs/agent-desktop/v${version}/LICENSE`); await writeFile(join(temporary, 'LICENSE.agent-desktop'), license);
  const hashes = {};
  async function walk(directory, prefix='') { for (const entry of await readdir(directory,{withFileTypes:true})) { const name=prefix+entry.name; if(entry.isDirectory())await walk(join(directory,entry.name),name+'/');else if(entry.isFile())hashes[name]=createHash('sha256').update(await readFile(join(directory,entry.name))).digest('hex'); } }
  await walk(temporary);
  await writeFile(join(temporary,'manifest.json'),JSON.stringify({protocolVersion:1,backend:'agent-desktop',version,platform,arch,archiveSha256:expected,hashes},null,2)+'\n');
  await replaceInstalledDirectory(destination, temporary);
} finally { await rm(temporary,{recursive:true,force:true}); }
console.log(`Bundled agent-desktop ${version} for ${platform}/${arch}`);
if(platform===process.platform)await buildWindowsSandbox();
