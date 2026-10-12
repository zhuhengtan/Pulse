import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  css: { postcss: { plugins: [] } },
  test: { environment: 'jsdom', include: ['tests/**/*.test.tsx'], pool: 'forks', fileParallelism: false },
})
