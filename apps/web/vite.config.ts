import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5656,
    proxy: {
      // dev tanpa set VITE_API_URL: /api diteruskan ke api lokal :3001
      '/api': 'http://localhost:3001',
    },
  },
  build: { outDir: 'dist' },
});
