import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set FALKORDB_GRAPH before application modules construct their env object.
    setupFiles: ['./tests/setup.ts'],
  },
});
