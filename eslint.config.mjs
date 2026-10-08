// @ts-check
import { createRequire } from 'node:module';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

const require = createRequire(import.meta.url);
const moduleBoundaries = require('./eslint-rules/module-boundaries.js');

export default tseslint.config(
  { ignores: ['dist/**', 'coverage/**', 'node_modules/**'] },

  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { local: { rules: { 'module-boundaries': moduleBoundaries } } },
    rules: {
      'local/module-boundaries': 'error',
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read config from lib/config `env` (CLAUDE.md §4).' },
      ],
    },
  },

  // Only these files may read process.env / write to the console.
  {
    files: ['src/lib/config/**/*.ts', 'test/**/*.ts', 'vitest.config.mts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    files: ['src/lib/logger/stdout-writer.ts', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },

  // Plain JS tooling files: no type information.
  {
    files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        __dirname: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
    rules: {
      ...tseslint.configs.disableTypeChecked.rules,
      'no-restricted-properties': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['eslint.config.mjs'],
    languageOptions: { sourceType: 'module' },
  },

  prettier,
);
