import { defineConfig } from 'vite'

const pulseH5Target = process.env.PULSE_H5_TARGET ?? 'http://127.0.0.1:7333'

export default defineConfig({
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: pulseH5Target,
        changeOrigin: true,
        configure: proxy => proxy.on('proxyReq', request => request.setHeader('Origin', new URL(pulseH5Target).origin)),
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    assetsDir: 'assets',
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return
          if (id.includes('/antd/') || id.includes('/@ant-design/icons/') || id.includes('/@rc-component/') || id.includes('/rc-')) return 'antd'
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor'
        },
      },
    },
    chunkSizeWarningLimit: 600,
  },
})
