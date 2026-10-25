import assert from 'node:assert/strict';
import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

// Inspect executable headers rather than filenames: native payloads can be
// extensionless, .node, .dll, .dylib, or hidden inside a dependency's vendor tree.
export async function verifyRuntimePlatform(root, platform = process.platform) {
    const binaries = [];
    async function walk(directory) {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) { await walk(path); continue; }
            if (!entry.isFile()) continue;
            const file = await open(path, 'r');
            let target;
            try {
                const header = Buffer.alloc(64), { bytesRead } = await file.read(header, 0, 64, 0);
                if (bytesRead < 4) continue;
                const magic = header.readUInt32BE(0);
                if (magic === 0x7f454c46) target = 'linux';
                else if ([0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe].includes(magic)) target = 'darwin';
                else if (magic === 0xcafebabe && bytesRead >= 8 && header.readUInt32BE(4) < 32) target = 'darwin'; // fat Mach-O, not Java bytecode
                else if (magic === 0xbebafeca && bytesRead >= 8 && header.readUInt32LE(4) < 32) target = 'darwin';
                else if (header.toString('ascii', 0, 2) === 'MZ' && bytesRead === 64) {
                    const signature = Buffer.alloc(4);
                    if ((await file.read(signature, 0, 4, header.readUInt32LE(60))).bytesRead === 4 && signature.readUInt32BE(0) === 0x50450000) target = 'win32';
                }
            } finally { await file.close(); }
            if (target) {
                assert.equal(target, platform, `Foreign native payload: ${relative(root, path)} (${target} in ${platform} runtime)`);
                binaries.push(relative(root, path));
            }
        }
    }
    await walk(root);
    return { platform, binaries };
}
