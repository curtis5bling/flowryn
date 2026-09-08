import eslint from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/coverage/**', '**/node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { import: importPlugin },
    settings: { 'import/resolver': { typescript: true } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'import/order': ['error', { alphabetize: { order: 'asc' }, 'newlines-between': 'always' }],
    },
  },
);