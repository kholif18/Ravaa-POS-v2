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
  // Pratinjau `vite preview` (port bawaan 4173) ikut meneruskan /api seperti
  // dev, supaya PWA hasil build bisa diuji end-to-end (service worker + API
  // nyata) TANPA bentrok port dengan dev server :5656.
  preview: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
