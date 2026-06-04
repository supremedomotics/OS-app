import { defineConfig } from "vitest/config";

// PGlite (embedded Postgres in WASM) spins up real database engines; under the
// monorepo's parallel test runs these need a generous timeout.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
