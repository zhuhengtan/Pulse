# @hunterzhu/pulse-runtime

[English](README.md)

Pulse 的核心 Agent Runtime：提供 Programs、Lanes、Agents 和 Outcomes。

## 要求

- Node.js 22+
- 仅支持 ESM

## 安装

```bash
npm install @hunterzhu/pulse-runtime
```

## 快速开始

保存为 `example.mjs` 并运行 `node example.mjs`。

```js
import { PulseRuntime, defineLaneProgram } from '@hunterzhu/pulse-runtime';

const program = defineLaneProgram({ id: 'hello', version: '1' }, (b) => {
  b.addStep('start', () => ({
    next: { complete: { value: { message: 'Hello, Pulse' } } },
  }));
});

const runtime = new PulseRuntime();
const { agentId } = runtime.createAgent('Say hello', program);
const outcome = await runtime.start(agentId).outcome();

console.log(outcome.status); // "succeeded"
```

此示例离线运行，不需要模型或凭据。真实模型和工具的连接方式见文档。

## 文档

- [文档](https://github.com/zhuhengtan/Pulse#readme)
- [源码](https://github.com/zhuhengtan/Pulse/tree/main/packages/runtime)
