# @hunterzhu/pulse-runtime

The core agent runtime for Pulse: programs, lanes, agents, and outcomes.

## Requirements

- Node.js 22+
- ESM only

## Install

```bash
npm install @hunterzhu/pulse-runtime
```

## Quick start

Save as `example.mjs` and run `node example.mjs`.

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

This example runs offline with no model or credentials. Connecting real models and
tools is described in the docs.

## Documentation

- [Documentation](https://github.com/zhuhengtan/Pulse#readme)
- [Source](https://github.com/zhuhengtan/Pulse/tree/main/packages/runtime)
