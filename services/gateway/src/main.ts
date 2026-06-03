import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Hub entry point for the Supreme API Gateway. Boots the Supreme plane (identity,
 * permissions, SIL) and serves REST + WSS. Phase 0 runs the mock backend so the
 * full path is exercisable with no HA or hardware (§19).
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = await AppContext.create(config);
  const app = await buildServer(ctx);

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await ctx.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { backend: config.backend, port: config.port },
    "Supreme API Gateway listening",
  );
}

main().catch((err) => {
  console.error("fatal: gateway failed to start", err);
  process.exit(1);
});
