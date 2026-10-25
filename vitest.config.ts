import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Keep Vite's config discovery inside the workspace when running in the sandbox.
  css: { postcss: { plugins: [] } },
  resolve: {
    alias: {
      '@hunterzhu/pulse-runtime': new URL('./packages/runtime/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-tool-sdk': new URL('./packages/tool-sdk/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-adapters': new URL('./packages/adapters/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-server/updates': new URL('./packages/server/src/updates/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-server': new URL('./packages/server/src/index.ts', import.meta.url).pathname,
      '@hunterzhu/pulse-cli': new URL('./packages/cli/src/bin.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    pool: 'forks',
    // Match the local CI budget: Host tests also spawn sandboxes and CLI workers.
    // CPU-count defaults oversubscribe those children and starve wall-clock waits.
    maxWorkers: 2,
    minWorkers: 1,
    setupFiles: ['tests/setup.ts'],
    // Windows SRT provisions one OS sandbox account and stamps filesystem ACLs.
    // Separate test processes must not race that machine-wide policy lifecycle.
    fileParallelism: process.platform !== 'win32',
    // A single cold SRT launch measured up to 146 seconds on hosted Windows.
    testTimeout: process.platform === 'win32' ? 180_000 : 10_000,
  },
})
