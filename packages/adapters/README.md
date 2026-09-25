# @hunterzhu/pulse-adapters

[简体中文](https://github.com/zhuhengtan/Pulse/blob/main/packages/adapters/README.zh-CN.md)

Provider and bridge adapters for Pulse — model providers plus filesystem, shell, and MCP bridges.

## Install

```bash
npm install @hunterzhu/pulse-adapters
```

Requires Node.js 22+. This package is ESM-only.

## Usage

`MockAdapter` is a network-free provider that returns scripted responses, which is handy for tests and local runs.

Save as `example.mjs` and run `node example.mjs`.

```js
import { MockAdapter } from '@hunterzhu/pulse-adapters';

const provider = new MockAdapter();
provider.enqueue({ text: 'Hello, Pulse', toolCalls: [], finishReason: 'stop' });

const attempt = await provider.executeAttempt();
console.log(attempt.text); // "Hello, Pulse"
```

This example runs offline and needs no credentials. For real providers, use
`createProviderAdapter({ provider, baseURL, defaultModel, apiKey })`; read the key in your
application, for example `apiKey: process.env.DEEPSEEK_API_KEY`. The CLI's
`apiKeyEnv` setting is not an adapter option.

The same package also exposes filesystem and shell bridges plus MCP support
for wiring external tool servers into Pulse.

## Documentation

- [Documentation](https://github.com/zhuhengtan/Pulse#readme)
- [Source](https://github.com/zhuhengtan/Pulse/tree/main/packages/adapters)
