import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// dev: Vite (5173) + proxy /api → Node 后端 (3001)
// prod: 构建产物输出到 ../dist-web,供 Node 后端 serve
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': '/src' },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../dist-web',
    emptyOutDir: true,
  },
});
