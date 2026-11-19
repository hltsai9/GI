import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves the demo from /GI/; local development uses /.
  base: (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.VITE_BASE ?? '/',
  plugins: [react()],
  server: { port: 5173, host: true, proxy: { '/api': 'http://localhost:3000' } },
  test: { environment: 'node' },
} as never);
