import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [react(), Icons({ compiler: 'jsx', jsx: 'react' })],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: 'react/jsx-dev-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-dev-runtime.js', import.meta.url)) },
      { find: 'react/jsx-runtime', replacement: fileURLToPath(new URL('./node_modules/react/jsx-runtime.js', import.meta.url)) },
      { find: 'react-dom', replacement: fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)) },
      { find: 'react', replacement: fileURLToPath(new URL('./node_modules/react', import.meta.url)) },
      { find: 'allotment', replacement: fileURLToPath(new URL('./node_modules/allotment', import.meta.url)) },
      { find: '@tanstack/react-virtual', replacement: fileURLToPath(new URL('./node_modules/@tanstack/react-virtual', import.meta.url)) },
    ],
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/main.js',
        assetFileNames: 'assets/[name][extname]',
        // 禁止 code splitting，所有代码打进单个 JS（CSP nonce 只加在入口 script 上）
        manualChunks: undefined,
        inlineDynamicImports: true,
      },
    },
    cssCodeSplit: false,
  },
  server: {
    hmr: false,
    watch: {
      followSymlinks: true,
    },
  },
});
