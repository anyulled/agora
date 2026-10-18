import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@agora/contracts': resolve(__dirname, 'packages/contracts/src/index.ts'),
      '@agora/domain': resolve(__dirname, 'packages/domain/src/index.ts'),
      '@agora/application': resolve(__dirname, 'packages/application/src/index.ts'),
      '@agora/reveal-plugin': resolve(__dirname, 'packages/reveal-plugin/src/index.ts'),
      '@agora/slide-export': resolve(__dirname, 'packages/slide-export/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
