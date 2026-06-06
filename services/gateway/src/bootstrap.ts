import {
  EntityRegistryMirror,
  HaAdapter,
  HaWsTransport,
  MigrationPolicy,
  MockAdapter,
  RoutingBackendAdapter,
  SupremeIntegrationLayer,
  SupremeNativeAdapter,
  type IBackendAdapter,
} from "@supreme/integration-layer";
import { createPersistence } from "@supreme/persistence";
import { createEventBus, createPresenceStore } from "@supreme/messaging";
import { HttpProtocolScanner } from "@supreme/commissioning";
import type { ProtocolKind } from "@supreme/domain-model";
import { assertSecureConfig, type GatewayConfig } from "./config.js";
import { AppContext, type AppDeps } from "./context.js";

/**
 * Hub boot edge. This is where the concrete, HA-specific WebSocket transport is
 * assembled and injected into the SIL — the only place in the codebase that wires
 * the loopback HA URL + long-lived token (both held inside the SIL). It is also
 * where the Postgres-backed stores are connected and migrated. Everything above
 * receives a ready {@link AppContext} and never learns a backend or DB exists.
 *
 * Defaults (no DATABASE_URL, SUPREME_BACKEND=mock) give the standalone slice used
 * in dev and tests: in-memory stores + the mock backend.
 */
export async function createHubContext(config: GatewayConfig): Promise<AppContext> {
  // Fail closed: never boot a production hub with insecure defaults.
  assertSecureConfig(config);
  const deps: AppDeps = {};

  if (config.databaseUrl) {
    const stores = await createPersistence({ connectionString: config.databaseUrl });
    deps.identityStore = stores.identity;
    deps.sessionStore = stores.sessions;
    deps.homeStore = stores.home;
    deps.sceneStore = stores.scenes;
    deps.grantStore = stores.grants;
    deps.notificationStore = stores.notifications;
    deps.driverStore = stores.drivers;
    deps.automationStore = stores.automations;
    deps.db = stores.db;
  }

  // Cross-process messaging: NATS event bus + Redis presence when configured,
  // otherwise the in-process defaults (dev/tests). Selected once here at the boot edge.
  deps.bus = await createEventBus({ natsUrl: config.natsUrl, redisUrl: config.redisUrl });
  deps.presence = await createPresenceStore({ natsUrl: config.natsUrl, redisUrl: config.redisUrl });

  // Register protocol scanners (KNX/DALI/Modbus) backed by the Python tooling.
  if (config.commissioningUrl) {
    const protocols: ProtocolKind[] = ["knx", "dali", "modbus"];
    deps.scanners = protocols.map(
      (protocol) => new HttpProtocolScanner({ protocol, baseUrl: config.commissioningUrl }),
    );
  }

  // The SIL is always backed by a routing adapter so per-domain native migration
  // (§16 Phase 4) is available: the "ha" side is the real HaAdapter or the mock
  // backend, and the native side is the Supreme-native engine. The shared registry
  // is what the router consults to route each domain.
  const registry = new EntityRegistryMirror();
  let haSide: IBackendAdapter;
  if (config.backend === "ha") {
    if (!config.haToken) throw new Error("SUPREME_BACKEND=ha requires SUPREME_HA_TOKEN");
    const transport = new HaWsTransport({ url: config.haUrl, token: config.haToken });
    haSide = new HaAdapter({ transport, registry });
  } else {
    haSide = new MockAdapter();
  }
  const router = new RoutingBackendAdapter({
    ha: haSide,
    native: new SupremeNativeAdapter(),
    registry,
    policy: new MigrationPolicy(),
  });
  deps.sil = new SupremeIntegrationLayer({ adapter: router, registry });

  return AppContext.create(config, deps);
}
