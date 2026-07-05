import { defineConfig } from "vitest/config";

// PGlite (embedded Postgres in WASM) spins up a real database engine. Under the monorepo's
// parallel CI runs the default worker-threads pool can crash the WASM instance ("Worker exited
// unexpectedly"), so run this package's tests in a single forked process and give PGlite a
// generous timeout to initialize.
export default defineConfig({
  test: {
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
