import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { defineConfig } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const server = process.env.COUNTEROKE_SERVER ?? 'http://localhost:3100';

/**
 * Writes .br and .gz copies of the built files once, at build time. The server sends those to
 * browsers that accept them, so the phone never spends CPU compressing at runtime.
 */
function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'counteroke-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const dir = path.join(outDir, 'assets');
      if (!fs.existsSync(dir)) return;
      for (const name of fs.readdirSync(dir)) {
        if (!/\.(js|css|svg|json)$/.test(name)) continue;
        const file = path.join(dir, name);
        const raw = fs.readFileSync(file);
        if (raw.length < 1024) continue;
        fs.writeFileSync(`${file}.br`, brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }));
        fs.writeFileSync(`${file}.gz`, gzipSync(raw, { level: 9 }));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), precompress()],
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
