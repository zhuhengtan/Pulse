import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  css: { postcss: { plugins: [] } },
  resolve: { alias: { '@hunterzhu/pulse-adapters/reasoning-effort': new URL('../adapters/src/providers/reasoning-effort.ts', import.meta.url).pathname, '@hunterzhu/pulse-server/model-settings': new URL('../server/src/model-settings.ts', import.meta.url).pathname, '@hunterzhu/pulse-server/run-presentation': new URL('../server/src/run-presentation.ts', import.meta.url).pathname } },
  test: { environment: 'jsdom', setupFiles: ['tests/setup.ts'], include: ['tests/**/*.test.tsx'], pool: 'forks', fileParallelism: false },
})
