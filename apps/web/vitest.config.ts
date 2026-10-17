import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  css: false,
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
