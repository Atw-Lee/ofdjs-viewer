import { defineConfig } from 'vite';
export default defineConfig({ publicDir: false, build: { outDir: 'dist/browser', emptyOutDir: true, sourcemap: true, lib: { entry: 'src/index.ts', formats: ['es'], fileName: () => 'ofdjs.js' } } });
