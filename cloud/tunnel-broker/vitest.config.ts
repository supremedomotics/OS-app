import { defineConfig } from "vitest/config";

// The mTLS tests issue real X.509 material (node-forge RSA-2048 keygen) and run full TLS handshakes.
// That keygen is CPU-heavy and far slower on CI runners than on a laptop, so give the suite a
// generous timeout. Tests wait on actual conditions (presence/reconnect) rather than fixed sleeps,
// but the keygen alone can dominate the default 5s budget under parallel CI load.
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
