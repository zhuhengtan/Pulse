// Drives a real Chromium over CDP pipe (no TCP port) to measure the chat footer
// with the repository's actual CSS: tests/fixtures/chat-footer-measure.html.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const target = new URL('./chat-footer-measure.html', import.meta.url).href;
const profile = process.env.CHROME_PROFILE_DIR || join(tmpdir(), 'pulse-chat-footer-profile');
mkdirSync(profile, { recursive: true });

const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-pipe',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-sandbox',
    '--allow-file-access-from-files',
    `--user-data-dir=${profile}`,
    `--crash-dumps-dir=${join(profile, 'crash')}`,
    '--window-size=1200,900',
    'about:blank'
  ],
  { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] }
);

const out = child.stdio[3];
const input = child.stdio[4];
let buffer = '';
let nextId = 1;
const pending = new Map();
const events = [];

input.setEncoding('utf8');
input.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\0')) !== -1) {
    const raw = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!raw.trim()) continue;
    const message = JSON.parse(raw);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method) {
      events.push(message);
    }
  }
});

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const payload = { id, method, params };
  if (sessionId) payload.sessionId = sessionId;
  out.write(JSON.stringify(payload) + '\0');
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function waitEvent(method, sessionId, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const hit = events.find((e) => e.method === method && (!sessionId || e.sessionId === sessionId));
    if (hit) {
      events.splice(events.indexOf(hit), 1);
      return hit;
    }
    await sleep(50);
  }
  return null;
}

async function evaluate(sessionId, expression) {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  return result.result?.value;
}

const MEASURE = `(() => {
  const el = document.querySelector('[data-measure="real"]');
  const control = document.querySelector('[data-measure="control"]');
  const pick = (node) => {
    if (!node) return null;
    const footer = node.querySelector('.message-footer');
    const time = node.querySelector('.message-time');
    return {
      footerOffsetHeight: footer ? footer.offsetHeight : null,
      timeOffsetHeight: time ? time.offsetHeight : null,
      messageOffsetHeight: node.offsetHeight,
      hovered: node.matches(':hover'),
      timeVisibility: time ? getComputedStyle(time).visibility : null
    };
  };
  return { real: pick(el), control: pick(control), readout: document.getElementById('readout').textContent };
})()`;

async function main() {
  await sleep(800);
  await send('Browser.getVersion');
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });

  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Page.navigate', { url: target }, sessionId);
  await waitEvent('Page.loadEventFired', sessionId);
  await sleep(400);

  const href = await evaluate(sessionId, 'location.href');
  const pre = await evaluate(sessionId, MEASURE);

  const box = await evaluate(
    sessionId,
    `(() => {
      const r = document.querySelector('[data-measure="real"] .bubble').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`
  );

  await send(
    'Input.dispatchMouseEvent',
    { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', buttons: 0, clickCount: 0 },
    sessionId
  );
  await sleep(300);
  const post = await evaluate(sessionId, MEASURE);

  console.log(JSON.stringify({ href, pre, post, verdict: verdict(pre, post) }, null, 2));
}

function verdict(pre, post) {
  const same =
    pre.real.footerOffsetHeight === post.real.footerOffsetHeight &&
    pre.real.messageOffsetHeight === post.real.messageOffsetHeight;
  const controlChanged =
    pre.control.footerOffsetHeight !== post.control.footerOffsetHeight ||
    pre.control.messageOffsetHeight !== post.control.messageOffsetHeight;
  return {
    realStable: same,
    controlDetectsReflow: controlChanged,
    hoverActuallyApplied: post.real.hovered === true && pre.real.hovered === false
  };
}

main()
  .then(() => {
    child.kill('SIGTERM');
    process.exit(0);
  })
  .catch((error) => {
    console.error('MEASURE_FAILED', error && error.message ? error.message : error);
    child.kill('SIGTERM');
    process.exit(1);
  });
