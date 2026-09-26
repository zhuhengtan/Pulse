# @hunterzhu/pulse-server

[English](README.md)

可编程宿主，可在你自己的进程中本地运行 Pulse 对话。

## 安装

```bash
npm install @hunterzhu/pulse-server
```

需要 Node.js 22+。此包仅支持 ESM。

## 使用

`createLocalHost` 会启动进程内宿主，并不是开箱即用的 HTTP Server。设置 `mockResponse` 后可以离线运行，无需 API Key；状态会写入 `dataDir`。

保存为 `example.mjs` 并运行 `node example.mjs`。

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

使用真实模型时，将 `provider: { provider: 'deepseek', baseURL: 'https://api.deepseek.com', defaultModel: 'deepseek-chat', apiKey: process.env.DEEPSEEK_API_KEY }` 传给 `createLocalHost`。从环境中读取凭据，不要硬编码。

## 文档

- [文档](https://github.com/zhuhengtan/Pulse#readme)
- [源码](https://github.com/zhuhengtan/Pulse/tree/main/packages/server)

## 许可证

此包采用 [PolyForm Noncommercial 1.0.0](./LICENSE)。商业用途需要另行获得许可。这是源码可见的非商业许可证，不是 OSI 认可的开源许可证。
