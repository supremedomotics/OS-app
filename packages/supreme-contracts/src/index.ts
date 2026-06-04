/**
 * @supreme/contracts — the contract-first Supreme API surface.
 *
 * Source of truth for REST request/response schemas, the WSS realtime protocol,
 * and the error model. SDKs (Dart + TS) and services validate against these so the
 * client ↔ backend boundary that protects the HA → native migration is guaranteed
 * by construction (§6, §15).
 */
export * from "./errors.js";
export * from "./rest.js";
export * from "./events.js";
export * from "./management.js";
export * from "./installer.js";
