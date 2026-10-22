import { defineConfig } from 'vite'

const pulseH5Target = process.env.PULSE_H5_TARGET ?? 'http://127.0.0.1:7333'

export default defineConfig({
  base: '/',
  server: {
    proxy: {
      '/file-preview': { target: pulseH5Target, changeOrigin: true },
      '/preview': { target: pulseH5Target, changeOrigin: true, ws: true },
      '/api': {
        target: pulseH5Target,
        changeOrigin: true,
        ws: true,
        configure: proxy => {
          const sameOrigin = (request: import('node:http').ClientRequest) => request.setHeader('Origin', new URL(pulseH5Target).origin)
          proxy.on('proxyReq', sameOrigin)
          proxy.on('proxyReqWs', (request, incoming, socket) => {
            let allowed = false
            try { allowed = typeof incoming.headers.origin === 'string' && new URL(incoming.headers.origin).origin === `http://${incoming.headers.host}` } catch { /* Reject malformed origins. */ }
            if (!allowed) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); request.destroy(); return }
            sameOrigin(request)
          })
        },
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
