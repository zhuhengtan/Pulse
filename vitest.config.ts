import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@hunterzhu/pulse-runtime': new URL('./packages/runtime/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-tool-sdk': new URL('./packages/tool-sdk/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-adapters': new URL('./packages/adapters/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-server': new URL('./packages/server/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-cli': new URL('./packages/cli/src/bin.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 10_000,
  },
})
