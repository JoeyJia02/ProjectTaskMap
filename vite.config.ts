import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'src/ui',
  plugins: [react(), viteSingleFile()],
  build: { outDir: '../../dist/ui', emptyOutDir: true, target: 'es2022' },
  server: { port: 5173, proxy: { '/api': 'http://127.0.0.1:3000' } },
});
