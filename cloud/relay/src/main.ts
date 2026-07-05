import { buildRelayServer } from "./relay-server.js";
import { PushDispatcher } from "./push-dispatcher.js";

/**
 * Relay entry point. Providers (FCM/APNs/WebPush) are wired from the cloud's secrets
 * here; with none configured, push is a no-op and only the remote-access tunnel runs.
 */
async function main(): Promise<void> {
  const hubAuthToken = process.env.SUPREME_RELAY_TOKEN ?? "";
  if (!hubAuthToken) throw new Error("SUPREME_RELAY_TOKEN is required");
  const app = buildRelayServer({
    hubAuthToken,
    dispatcher: new PushDispatcher([]), // real providers wired from cloud secrets
    logLevel: process.env.SUPREME_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.PORT ?? 8090);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: relay failed to start", err);
  process.exit(1);
});
