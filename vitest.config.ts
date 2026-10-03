import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Exported release snapshots are evidence, not a second test workspace.
    exclude: [...configDefaults.exclude, '**/dist/**', '**/build/**', '**/build-headless/**'],
  },
});
