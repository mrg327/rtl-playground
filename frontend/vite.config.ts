import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    outDir: '../src/rtl_playground/static',
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://127.0.0.1:8765' },
  },
  test: { include: ['test/**/*.test.ts'] },
});
