import { defineConfig, mergeConfig } from 'vitest/config';
import webviewConfig from './vite.config';

export default mergeConfig(webviewConfig, defineConfig({
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
}));
