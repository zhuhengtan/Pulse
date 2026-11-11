import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Local development launcher only; quitting the shell deliberately leaves its backend alive. */
export async function developmentControl({ userData, appPath, quit }) {
  const token = randomBytes(32).toString('hex');
  const identity = { protocol: 1, pid: process.pid, appPath: resolve(appPath), userData: resolve(userData) };
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(403).end(); return; }
    if (request.url === '/identity' && request.method === 'GET') { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(identity)); return; }
    if (request.url === '/quit' && request.method === 'POST') { response.writeHead(200).end('{}', () => setImmediate(quit)); return; }
    response.writeHead(404).end();
  });
  try {
    await new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', done); });
    server.unref();
    await mkdir(userData, { recursive: true });
    const target = join(userData, 'development-desktop.json'), temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify({ ...identity, port: server.address().port, token }), { mode: 0o600 });
    await rename(temporary, target);
    // Leave a stale descriptor on exit: the next launch replaces it. An old
    // process must never asynchronously unlink a newer instance's descriptor.
    return () => server.close();
  } catch (error) { server.close(); throw error; }
}
