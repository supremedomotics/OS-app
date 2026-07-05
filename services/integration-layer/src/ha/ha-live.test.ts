import { describe, expect, it } from "vitest";
import { HaAdapter } from "./ha-adapter.js";
import { HaWsTransport } from "./ha-ws-transport.js";
import { EntityRegistryMirror } from "../registry.js";
import { SupremeIntegrationLayer } from "../sil.js";

/**
 * Live Home Assistant integration test — runs ONLY when a real HA is provided via
 * `SUPREME_HA_TEST_URL` (ws://host:8123/api/websocket) and `SUPREME_HA_TEST_TOKEN`
 * (a long-lived access token). Skipped otherwise (CI, dev without HA). This is how
 * we validate the SIL against a real HA instance before release (readiness §2).
 *
 *   docker compose -f infra/hub-compose/docker-compose.ha-test.yml up -d
 *   # create a user + long-lived token in HA, then:
 *   SUPREME_HA_TEST_URL=ws://127.0.0.1:8123/api/websocket \
 *   SUPREME_HA_TEST_TOKEN=<token> pnpm --filter @supreme/integration-layer test
 */
const url = process.env.SUPREME_HA_TEST_URL;
const token = process.env.SUPREME_HA_TEST_TOKEN;
const run = url && token ? describe : describe.skip;

run("Live HA integration", () => {
  it("authenticates and discovers entities from a real HA", async () => {
    const registry = new EntityRegistryMirror();
    const transport = new HaWsTransport({ url: url!, token: token! });
    const adapter = new HaAdapter({ transport, registry });
    const sil = new SupremeIntegrationLayer({ adapter, registry });
    try {
      await sil.start();
      expect(sil.isHealthy()).toBe(true);
      const discovered = await sil.discover();
      // A real HA exposes at least sun.sun / persistent_notification-style entities;
      // we only assert the transport+mapper round-trips real payloads.
      expect(Array.isArray(discovered)).toBe(true);
    } finally {
      await sil.stop();
    }
  }, 20000);
});
