import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '.wrangler/**',
      '.git/**',
      'harness/maker_checker_graph.py',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.browser,
        ...globals.es2022,
      },
    },
    files: ['**/*.{ts,mts,mjs,js}'],
    rules: {
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-throw-literal': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/consistent-type-definitions': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/no-empty-function': 'off',
    },
  },
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['cloudflare:*', '@cloudflare/*', 'wrangler', 'wrangler/*'],
              message:
                'Clean Architecture violation: @agora/domain must remain pure and cannot import Cloudflare runtime modules.',
            },
            {
              group: ['react', 'react-*', 'react/*'],
              message:
                'Clean Architecture violation: @agora/domain must remain pure and cannot import React or UI modules.',
            },
            {
              group: ['reveal.js', 'reveal.js/*'],
              message:
                'Clean Architecture violation: @agora/domain must remain pure and cannot import Reveal.js.',
            },
            {
              group: [
                '@agora/application',
                '@agora/application/*',
                '@agora/worker',
                '@agora/admin',
                '@agora/audience',
                '@agora/presenter',
                '@agora/reveal-plugin',
                '@agora/slide-export',
              ],
              message:
                'Clean Architecture violation: @agora/domain may only depend on @agora/contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['packages/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['cloudflare:*', '@cloudflare/*', 'wrangler', 'wrangler/*'],
              message:
                'Clean Architecture violation: @agora/application must remain pure and cannot import Cloudflare runtime modules.',
            },
            {
              group: ['react', 'react-*', 'react/*'],
              message:
                'Clean Architecture violation: @agora/application must remain pure and cannot import React or UI modules.',
            },
            {
              group: ['reveal.js', 'reveal.js/*'],
              message:
                'Clean Architecture violation: @agora/application must remain pure and cannot import Reveal.js.',
            },
            {
              group: [
                '@agora/worker',
                '@agora/admin',
                '@agora/audience',
                '@agora/presenter',
                '@agora/reveal-plugin',
                '@agora/slide-export',
              ],
              message:
                'Clean Architecture violation: @agora/application may only depend on @agora/contracts and @agora/domain.',
            },
          ],
        },
      ],
    },
  },
);
