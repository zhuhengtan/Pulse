# @hunterzhu/pulse-tool-sdk

[简体中文](https://github.com/zhuhengtan/Pulse/blob/main/packages/tool-sdk/README.zh-CN.md)

Define, register, and execute tools for Pulse agents with typed inputs and outputs.

## Requirements

- Node.js 22+
- ESM only
- Zod 3 for the example below

## Install

```bash
npm install @hunterzhu/pulse-tool-sdk zod@^3
```

## Quick start

Save as `example.mjs` and run `node example.mjs`.

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

This example runs offline with no model or credentials.

## Documentation

- [Documentation](https://github.com/zhuhengtan/Pulse#readme)
- [Source](https://github.com/zhuhengtan/Pulse/tree/main/packages/tool-sdk)

## License

This package is licensed under [PolyForm Noncommercial 1.0.0](./LICENSE). Commercial use requires separate permission. This is a source-available noncommercial license, not an OSI-approved open-source license.
