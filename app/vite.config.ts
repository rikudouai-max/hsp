import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/drive-proxy': {
        target: 'https://drive.google.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/drive-proxy/, ''),
        followRedirects: true,
      }
    }
  }
});
