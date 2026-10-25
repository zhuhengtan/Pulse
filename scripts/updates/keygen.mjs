import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = process.argv[2], keyId = process.argv[3];
if (!path || !keyId || !/^[a-zA-Z0-9-]+$/.test(keyId)) throw new Error('Usage: node scripts/updates/keygen.mjs <private-key-path-outside-repo> <key-id>');
const root = fileURLToPath(new URL('../../', import.meta.url));
if (resolve(path).startsWith(root)) throw new Error('Private keys must be stored outside the repository');
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
const desktop = new URL('../../packages/desktop/src/update-keys.json', import.meta.url);
const keys = JSON.parse(await readFile(desktop, 'utf8'));
if (keys[keyId]) throw new Error('Key ID already exists; use a new rotation ID');
keys[keyId] = publicKey.export({ type: 'spki', format: 'pem' }).toString();
await writeFile(desktop, JSON.stringify(keys, null, 2) + '\n');
await writeFile(new URL('../../packages/server/src/updates/trusted-keys.ts', import.meta.url), '// Public release verification keys. Private keys never belong in this repository.\nexport const trustedKeys: Record<string, string> = ' + JSON.stringify(keys, null, 2) + '\n');
console.log('Created an Ed25519 release key outside the repository and pinned its public key in server and shell.');
