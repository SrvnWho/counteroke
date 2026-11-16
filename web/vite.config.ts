import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.COUNTEROKE_SERVER ?? 'http://localhost:3100';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: {
      '/api': server,
      '/media': server,
      '/socket.io': { target: server, ws: true },
    },
  },
});
