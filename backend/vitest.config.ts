import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Set FALKORDB_GRAPH before application modules construct their env object.
    setupFiles: ['./tests/setup.ts'],
    // All graph tests share one external FalkorDB instance (MEMORYGUARD_TEST).
    // Running test files in parallel would let them clear each other's data, so
    // serialize files. Tests within a file already run sequentially by default.
    fileParallelism: false,
  },
});
