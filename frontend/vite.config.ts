import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /api/* is proxied to the backend so the frontend needs no CORS config.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
