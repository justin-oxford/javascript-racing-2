import { defineConfig } from 'vitest/config';
import { trackPlugin } from './tools/vite-track-plugin';

export default defineConfig({
  // Relative base so the build works at any path (GitHub Pages project URL, or a subpath later).
  base: './',
  // Keep Vite's hashed output apart from /public/assets (copied sprites, backgrounds, fonts).
  build: { assetsDir: 'build' },
  plugins: [trackPlugin()],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tools/**/*.test.ts'],
  },
});
