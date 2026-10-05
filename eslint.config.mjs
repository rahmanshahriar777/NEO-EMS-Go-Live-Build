import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/out/**',
      '**/*.d.ts',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      // 'warn' (not 'error') for now: several committed apps/web pages carry
      // unused `React` default imports (harmless under the new JSX transform),
      // so 'error' would break `turbo run lint` today. Clean those imports up
      // and escalate this to 'error'.
      '@typescript-eslint/no-unused-vars': 'warn',
      // The codebase logs intentionally (Nest Logger, config warnings);
      // 'error' would break the build, so violations surface as warnings.
      'no-console': 'warn',
    },
  },
];
