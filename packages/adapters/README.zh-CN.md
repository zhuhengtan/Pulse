# @hunterzhu/pulse-adapters

[English](README.md)

Pulse 的 Provider 与桥接适配器，包括模型 Provider，以及 filesystem、shell 和 MCP 桥接。

## 安装

```bash
npm install @hunterzhu/pulse-adapters
```

需要 Node.js 22+。此包仅支持 ESM。

## 使用

`MockAdapter` 是无需网络的 Provider，会返回预先设置的响应，适用于测试和本地运行。

保存为 `example.mjs` 并运行 `node example.mjs`。

```js
import { MockAdapter } from '@hunterzhu/pulse-adapters';

const provider = new MockAdapter();
provider.enqueue({ text: 'Hello, Pulse', toolCalls: [], finishReason: 'stop' });

const attempt = await provider.executeAttempt();
console.log(attempt.text); // "Hello, Pulse"
```

此示例离线运行且不需要凭据。连接真实 Provider 时，使用 `createProviderAdapter({ provider, baseURL, defaultModel, apiKey })`；应用可以从环境变量读取密钥，例如 `apiKey: process.env.DEEPSEEK_API_KEY`。CLI 的 `apiKeyEnv` 配置不是适配器选项。

同一个包还提供 filesystem、shell 桥接和 MCP 支持，用于将外部工具服务接入 Pulse。

## 文档

- [文档](https://github.com/zhuhengtan/Pulse#readme)
- [源码](https://github.com/zhuhengtan/Pulse/tree/main/packages/adapters)
