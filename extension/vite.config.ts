import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: 'src/background.ts',
        content: 'src/content.ts',
      },
      output: {
        entryFileNames: '[name].js',
        format: 'es',
      },
    },
  },
});
