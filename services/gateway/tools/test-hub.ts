/**
 * A real gateway (HTTP + WSS + SIL + scene runner + state feed) on a random local port, authorized
 * the way a paired Mobile is — for client integration tests that must not fake the Hub (§ Phase 3
 * contract drift gate). Prints ONE line of JSON on stdout when it is ready, then serves until
 * killed:
 *
 *   {"baseUrl":"http://127.0.0.1:PORT","streamUrl":"ws://127.0.0.1:PORT/v1/stream","token":"…"}
 *
 * The device layer is the gateway's built-in mock backend (no physical hardware) — everything
 * above it is production code. The token is a Mobile authorization (5-minute TTL).
 *
 *   pnpm --filter @supreme/gateway exec tsx tools/test-hub.ts
 */
import { issueMobileAuthorizationToken } from "@supreme/hub-identity";
import { AppContext, buildServer, loadConfig } from "../src/index.js";

const ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
const app = await buildServer(ctx);
await app.listen({ host: "127.0.0.1", port: 0 });
const addr = app.server.address();
const port = typeof addr === "object" && addr ? addr.port : 0;

ctx.mobileAuthorizations.upsert({
  mobileId: "dart-it",
  publicKeyBase64: "pk",
  hubId: ctx.hubIdentity.hubUuid,
  projectId: ctx.homeId,
  label: "Dart integration test",
  pairedAt: new Date().toISOString(),
  lastSeenAt: null,
  revoked: false,
  revokedAt: null,
});
const token = issueMobileAuthorizationToken(ctx.hubIdentity, {
  mobileId: "dart-it",
  hubId: ctx.hubIdentity.hubUuid,
  projectId: ctx.homeId,
});

console.log(
  JSON.stringify({
    baseUrl: `http://127.0.0.1:${port}`,
    streamUrl: `ws://127.0.0.1:${port}/v1/stream`,
    token,
    // The owner login lets a test author its own Experience (the Hub owns the write path).
    ownerLogin: { email: "owner@supreme.local", password: "supreme-owner-demo-pass" },
  }),
);

const stop = async () => {
  await app.close();
  await ctx.shutdown();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
