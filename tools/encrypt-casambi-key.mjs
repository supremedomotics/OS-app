#!/usr/bin/env node
// Encrypts a real Casambi Cloud API key against the fixed EMBEDDED_APP_KEY in
// services/gateway/src/casambi-embedded-key.ts, so it can be committed to source as
// ciphertext (never plaintext) and decrypted automatically at hub boot — see that file's own
// header comment for the full design rationale.
//
// Run this on YOUR OWN machine — never paste the real key anywhere else, including chat:
//   node tools/encrypt-casambi-key.mjs "your-real-casambi-api-key"
//
// Paste the printed ciphertext into ENCRYPTED_CASAMBI_API_KEY in
// services/gateway/src/casambi-embedded-key.ts, then commit that file. The real key itself
// never needs to be committed or shared with anyone running install.sh.

import { createCipheriv, randomBytes } from "node:crypto";

const EMBEDDED_APP_KEY = "p3V5HQ4IcPn+zJEY192klcshO8fzFaXfVjNPKJ3AuQM=";

function encryptSecret(plaintext, keyB64) {
  const key = Buffer.from(keyB64, "base64");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

const apiKey = process.argv[2];
if (!apiKey) {
  console.error('Usage: node tools/encrypt-casambi-key.mjs "your-real-casambi-api-key"');
  process.exit(1);
}

console.log(encryptSecret(apiKey, EMBEDDED_APP_KEY));
