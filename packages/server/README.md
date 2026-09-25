# @hunterzhu/pulse-server

[简体中文](https://github.com/zhuhengtan/Pulse/blob/main/packages/server/README.zh-CN.md)

Programmatic host that runs Pulse conversations locally inside your own process.

## Install

```bash
npm install @hunterzhu/pulse-server
```

Requires Node.js 22+. This package is ESM-only.

## Usage

`createLocalHost` starts an in-process host — it is not an out-of-the-box HTTP
server. With `mockResponse` set it runs offline with no API key, and state is
written under `dataDir`.

Save as `example.mjs` and run `node example.mjs`.

```js
import { createLocalHost } from '@hunterzhu/pulse-server';

const host = createLocalHost({
  cwd: process.cwd(),
  dataDir: '.pulse-demo',
  mockResponse: 'Hello, Pulse',
});

try {
  await host.init();
  const conversation = await host.createConversation();
  const run = await host.sendMessage(conversation.id, { text: 'Say hello' });
  console.log((await run.outcome()).text);
} finally {
  await host.close();
}
```

For a real model, pass `provider: { provider: 'deepseek', baseURL: 'https://api.deepseek.com',
defaultModel: 'deepseek-chat', apiKey: process.env.DEEPSEEK_API_KEY }` to `createLocalHost`.
Read credentials from the environment; never hard-code them.

## Documentation

- [Documentation](https://github.com/zhuhengtan/Pulse#readme)
- [Source](https://github.com/zhuhengtan/Pulse/tree/main/packages/server)
