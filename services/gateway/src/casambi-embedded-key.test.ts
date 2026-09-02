import { describe, expect, it } from "vitest";
import { resolveEmbeddedCasambiApiKey } from "./casambi-embedded-key.js";

// The embedded ciphertext constant is blank until a real key is encrypted in (see that file's
// own header + tools/encrypt-casambi-key.mjs) — @supreme/crypto's own tests already cover
// encrypt/decrypt correctness, so this only checks the module's "nothing embedded yet" default.
describe("resolveEmbeddedCasambiApiKey", () => {
  it("returns undefined when no ciphertext is embedded", () => {
    expect(resolveEmbeddedCasambiApiKey()).toBeUndefined();
  });
});
