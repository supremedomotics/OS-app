import { describe, expect, it } from "vitest";
import { resolveEmbeddedCasambiApiKey } from "./casambi-embedded-key.js";

// Never asserts the real decrypted value (that would put the plaintext key in source/CI logs) —
// @supreme/crypto's own tests already cover encrypt/decrypt correctness. This only checks the
// module's own contract: once ENCRYPTED_CASAMBI_API_KEY is filled in (via
// tools/encrypt-casambi-key.mjs), decryption against the fixed embedded app key succeeds and
// yields a real, non-empty string every time it's called.
describe("resolveEmbeddedCasambiApiKey", () => {
  it("decrypts to a non-empty string when a real key is embedded", () => {
    const key = resolveEmbeddedCasambiApiKey();
    expect(typeof key).toBe("string");
    expect((key ?? "").length).toBeGreaterThan(0);
  });

  it("is deterministic across calls", () => {
    expect(resolveEmbeddedCasambiApiKey()).toBe(resolveEmbeddedCasambiApiKey());
  });
});
