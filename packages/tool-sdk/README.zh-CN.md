# @hunterzhu/pulse-tool-sdk

[English](README.md)

为 Pulse Agent 定义、注册并执行具有类型化输入和输出的工具。

## 要求

- Node.js 22+
- 仅支持 ESM
- 以下示例需要 Zod 3

## 安装

```bash
npm install @hunterzhu/pulse-tool-sdk zod@^3
```

## 快速开始

保存为 `example.mjs` 并运行 `node example.mjs`。

```js
import { z } from 'zod';
import { defineTool, ToolRegistry } from '@hunterzhu/pulse-tool-sdk';

const registry = new ToolRegistry();

registry.register(
  defineTool({
    name: 'greet',
    description: 'Greet someone',
    input: z.object({ name: z.string() }),
    output: z.object({ text: z.string() }),
    sideEffectPolicy: 'none',
    execute: ({ name }) => ({ text: `Hello, ${name}!` }),
  })
);

console.log(await registry.execute('greet', { name: 'Pulse' }, new AbortController().signal));
// { text: 'Hello, Pulse!' }
```

此示例离线运行，不需要模型或凭据。

## 文档

- [文档](https://github.com/zhuhengtan/Pulse#readme)
- [源码](https://github.com/zhuhengtan/Pulse/tree/main/packages/tool-sdk)
