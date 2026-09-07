import type { DiscoveredDevice, INativeProtocolDriver, ProtocolBinding } from "@supreme/integration-layer";
import {
  AvrProtocolDriver,
  CasambiProtocolDriver,
  CoolMasterProtocolDriver,
  HeosProtocolDriver,
  KnxProtocolDriver,
  ModbusProtocolDriver,
  MqttProtocolDriver,
  YamahaProtocolDriver,
} from "@supreme/protocols";
import { LocalDirectUdpTransport, type UdpTransport } from "@supreme/lan";
import type { CasambiCredentials } from "@supreme/protocols";

/**
 * Native driver factories — the manifest↔runtime bridge. Given a driver's PROTOCOL and its stored
 * config (from the manifest config schema), build the matching {@link INativeProtocolDriver}. This is
 * how an installed + enabled + configured driver becomes a live protocol stack, instead of the old
 * env-only wiring in bootstrap.ts. A protocol with no factory (or missing required config) yields
 * null and simply isn't brought up at runtime.
 */
export type DriverLogFn = (level: "info" | "warn" | "error", message: string) => void;
export interface NativeDriverFactoryContext {
  onLog?: DriverLogFn;
  /** § Universal AVR SDK — builds the gateway's own artwork-proxy URL for a device
   * (`/v1/devices/:id/media/artwork`), same pattern `bootstrap.ts` already wires for the
   * env-only Apple TV driver. Absent when the gateway has no `publicBaseUrl` configured
   * (dev/local) — a driver that needs this treats absence as "don't proxy," never throws. */
  artworkUrlFor?: (deviceId: string) => string;
  /** § AVR Diagnostic Mode — off by default; forwarded only to the `avr` factory below (the
   * only driver that currently implements diagnostics). See `GatewayConfig.avrDiagnostics`. */
  avrDiagnostics?: boolean;
  /** § LAN Transport Phase 2 — factory for the generic, protocol-agnostic `UdpTransport`
   * (`@supreme/lan`) every LAN-broadcast/multicast-dependent driver should use instead of opening
   * a raw socket itself (Casambi today; KNX/Matter/mDNS/SSDP later). Decided ONCE, centrally, by
   * `services/gateway/src/installer-context.ts`'s `nativeDriverContext()` — real NATS configured
   * -> `NatsUdpTransportClient` reaching a separate `supreme-lan` service; no NATS configured
   * (single-process dev) -> `LocalDirectUdpTransport` (real `node:dgram`, same process). Absent
   * only in tests that construct a factory directly — falls back to `LocalDirectUdpTransport` so
   * a missing context never silently breaks a LAN-dependent driver. */
  udpTransportFactory?: () => UdpTransport;
  /** § Casambi fleet-wide default account — the SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD/
   * NETWORK_ID env vars (config.ts). Each field is independently optional: only `apiKey` is
   * genuinely deployment-wide today (the embedded default — casambi-embedded-key.ts, or an
   * explicit env override); email/password are per-project fields entered on each driver
   * instance and only appear here if a deployment ALSO happens to set the env-var default. Used
   * as a FALLBACK by the `casambi` factory's Cloud branch and `resolveCasambiCloudCredentials`
   * when this driver instance's own manifest config leaves a field blank — `apiKey` alone is
   * enough for a deployment to never require typing it. Never a literal credential in source —
   * only ever read from the running deployment's own environment/secrets. */
  casambiCloudDefaults?: { apiKey?: string; email?: string; password?: string; networkId?: string };
}
export type NativeDriverFactory = (config: Record<string, unknown>, ctx: NativeDriverFactoryContext) => INativeProtocolDriver | null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : v !== undefined && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** § Casambi fleet-wide default account — shared by the `casambi` factory's Cloud branch below
 * and `routes/installer.ts`'s Local Gateway Cloud actions (name sync + device discovery), so the
 * same driver-config-then-fleet-default precedence isn't duplicated in multiple places. `config`
 * is a driver instance's own stored config; `defaults` is `casambiCloudDefaults`, each field
 * independently optional (typically just `apiKey` — the one genuinely deployment-wide default;
 * see that field's own doc comment). Resolved per-field: a driver's own config wins, falling back
 * to `defaults` field-by-field — never all-or-nothing. Returns null only when apiKey/email/
 * password aren't ALL resolved from either source combined. */
export function resolveCasambiCloudCredentials(
  config: Record<string, unknown>,
  defaults?: { apiKey?: string; email?: string; password?: string; networkId?: string },
): CasambiCredentials | null {
  const apiKey = str(config.apiKey) ?? defaults?.apiKey;
  const email = str(config.email) ?? defaults?.email;
  const password = str(config.password) ?? defaults?.password;
  if (!apiKey || !email || !password) return null;
  const networkId = str(config.networkId) ?? defaults?.networkId;
  return { apiKey, email, password, ...(networkId ? { networkId } : {}) };
}

export const NATIVE_DRIVER_FACTORIES: Record<string, NativeDriverFactory> = {
  knx: (c) => {
    const host = str(c.host);
    return host ? new KnxProtocolDriver({ host, port: int(c.port, 3671) }) : null;
  },
  mqtt: (c) => {
    const url = str(c.url);
    return url ? new MqttProtocolDriver({ url, username: str(c.username), password: str(c.password) }) : null;
  },
  modbus: (c) => {
    const host = str(c.host);
    return host ? new ModbusProtocolDriver({ host, port: int(c.port, 502) }) : null;
  },
  casambi: (c, ctx) => {
    // § Casambi Driver Refactor — Foundation: `connectionType` is new. Absent (every
    // deployment/config stored before this refactor) defaults to "cloud" — identical
    // construction to before, zero behavior change for existing installs.
    const connectionType = str(c.connectionType) ?? "cloud";
    const onLog = c.logging === true ? ctx.onLog : undefined;
    if (connectionType === "local") {
      const gatewayIp = str(c.gatewayIp);
      const restPort = int(c.restPort, NaN);
      const udpPort = int(c.udpPort, NaN);
      if (!gatewayIp || !Number.isFinite(restPort) || !Number.isFinite(udpPort)) return null;
      const dataFormat = str(c.dataFormat) === "dec-hash" ? "dec-hash" : "hex-dot";
      return new CasambiProtocolDriver({
        connectionMode: "local",
        local: {
          gatewayIp,
          restPort,
          udpPort,
          netId: int(c.netId, 0),
          dataFormat,
          gatewayName: str(c.gatewayName),
          gatewayUsername: str(c.gatewayUsername),
          gatewayPassword: str(c.gatewayPassword),
          autoDiscover: c.autoDiscover === true,
          // § LAN Transport Phase 2 — Casambi no longer owns a raw socket; every Local UDP send/
          // receive goes through this generic transport factory.
          udpTransportFactory: ctx.udpTransportFactory ?? (() => new LocalDirectUdpTransport()),
        },
        onLog,
        trace: c.logging === true,
      });
    }
    const creds = resolveCasambiCloudCredentials(c, ctx.casambiCloudDefaults);
    if (!creds) return null;
    return new CasambiProtocolDriver({
      credentials: creds,
      onLog,
      trace: c.logging === true,
    });
  },
  coolmaster: (c) => {
    const host = str(c.host);
    if (!host) return null;
    const protocol = str(c.protocol);
    return new CoolMasterProtocolDriver({
      host,
      ...(protocol === "auto" || protocol === "ascii" || protocol === "rest" ? { protocol } : {}),
      asciiPort: int(c.asciiPort, 10102),
      restPort: int(c.restPort, 10103),
      pollMs: int(c.pollMs, 10_000),
      timeoutMs: int(c.timeoutMs, 5_000),
      retryCount: int(c.retryCount, 3),
      debug: c.debug === true,
    });
  },
  // AVR/HEOS/Yamaha have no global host/credentials to configure here — each physical
  // unit is added by IP (and zone/pid) through a `ProtocolBinding` at commissioning
  // (Installer → Bus Binding), same as the pre-existing env-wired instances in
  // bootstrap.ts. The factory therefore always succeeds; installing + enabling the
  // extension is what brings the driver up (§ ADR 0015).
  avr: (c, ctx) => new AvrProtocolDriver({ onLog: ctx.onLog, trace: c.trace === true, artworkUrlFor: ctx.artworkUrlFor, diagnostics: ctx.avrDiagnostics === true }),
  heos: (c, ctx) => new HeosProtocolDriver({ onLog: ctx.onLog, trace: c.trace === true }),
  yamaha: (c, ctx) => new YamahaProtocolDriver({ onLog: ctx.onLog, trace: c.trace === true }),
};

/**
 * § Multi-network Casambi — wrap a built driver so it reports a DIFFERENT `.protocol` string
 * than the one used to build it, without touching the driver class itself or any other protocol.
 * Needed because `SupremeNativeAdapter` (the SIL) keys its live driver registry, connect/
 * disconnect, and device ownership entirely off `driver.protocol` — one live instance per
 * string. A catalog key can now be installed more than once (one Casambi network / Lithernet
 * gateway per instance), so every instance beyond the first needs its OWN string
 * (`"casambi#<installedId>"`) or registering the second would silently replace the first's live
 * connection (`native-adapter.ts`'s `registerDriver` docs this: "replace any existing instance for
 * this protocol"). The first/primary instance keeps the bare protocol name unchanged, so a
 * single-instance install — still the overwhelming common case, and every already-deployed hub
 * — needs no migration and behaves byte-for-byte as before.
 *
 * A Proxy, not a manual field-by-field wrapper, because {@link INativeProtocolDriver} carries
 * ~20 mostly-optional methods (AVR diagnostics, keypad feedback, artwork, scenes, …); forwarding
 * each by hand would be large and silently drift as the interface grows. Methods are rebound to
 * the real instance (`Reflect.get(target, prop, target)` then `.bind(target)`) so internal `this`
 * still resolves to the concrete driver — required for any class using native `#private` fields,
 * which fail their brand check if invoked with the Proxy itself as `this`.
 */
export function withRuntimeProtocol<T extends INativeProtocolDriver>(driver: T, runtimeProtocol: string): T {
  if (driver.protocol === runtimeProtocol) return driver;
  return new Proxy(driver, {
    get(target, prop, receiver) {
      if (prop === "protocol") return runtimeProtocol;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Casambi's own address prefix — matches `discovery-engine.ts`'s `backendId: \`casambi:${unit.id}\``
 * and `casambi-driver.ts`'s `unitIdFromBinding()` parsing (`address.replace(/^casambi:/, "")`)
 * exactly. Both stay completely untouched; this module only ever translates around them. */
const CASAMBI_PREFIX = "casambi:";

/** "casambi:45" (bare) -> "casambi:<instanceId>:45" (scoped). Exported so route handlers that
 * build a Casambi backendId themselves (group membership, pairing) can produce the SAME scoped
 * form a discovered device would carry, instead of re-deriving the rule by hand. */
export function scopeCasambiBackendId(bareBackendId: string, instanceId: string): string {
  const rest = bareBackendId.startsWith(CASAMBI_PREFIX) ? bareBackendId.slice(CASAMBI_PREFIX.length) : bareBackendId;
  return `${CASAMBI_PREFIX}${instanceId}:${rest}`;
}

/** The unit id a Casambi backendId names, regardless of whether it's bare ("casambi:45") or
 * instance-scoped ("casambi:<instanceId>:45") — the LAST colon-separated segment, always. Lets a
 * caller compare group membership (raw unit-id numbers, never address strings) against discovered
 * backendIds without having to know or reconstruct which instance's scoping rule applies. `null`
 * for anything not shaped like a Casambi backendId at all. */
export function casambiUnitIdFromBackendId(backendId: string): number | null {
  if (!backendId.startsWith(CASAMBI_PREFIX)) return null;
  const parts = backendId.split(":");
  const n = Number(parts[parts.length - 1]);
  return Number.isFinite(n) ? n : null;
}

/** The inverse: strips a scoped address back to the bare form the REAL `CasambiProtocolDriver`
 * understands. An address already bare, or scoped to some OTHER instance (shouldn't happen —
 * routing already picked this driver instance via its own scoped runtime protocol string before
 * this is ever called), passes through unchanged rather than guessing. */
export function unscopeCasambiBackendId(address: string, instanceId: string): string {
  const scopedPrefix = `${CASAMBI_PREFIX}${instanceId}:`;
  return address.startsWith(scopedPrefix) ? `${CASAMBI_PREFIX}${address.slice(scopedPrefix.length)}` : address;
}

/**
 * § Multi-network Casambi, Stage 4 — network-scoped Casambi addressing.
 *
 * `casambi:45` collides the moment two Casambi networks (or two Lithernet gateways) both have a
 * "unit 45" — indistinguishable at every layer that keys off backendId (discovery dedup, the
 * SIL's global `reverseLookup` index). The fix: a driver's OWN installed id becomes part of the
 * address for any instance but the first — `casambi:<installedId>:<unitId>` — which cannot
 * collide with a sibling instance's address for the identical unit, because installed ids are
 * globally unique and permanent. NOT the Casambi network ID (doesn't exist in Local mode at all)
 * and NOT the installer-facing label (renamable, sometimes absent) — see this stage's own design
 * note for why those were rejected.
 *
 * The FIRST/primary instance (`instanceId === null`) is returned completely unwrapped: every
 * already-persisted single-instance binding/device keeps its bare `casambi:45` address forever,
 * with no migration and no behavior change — matching every other backward-compat rule this
 * multi-instance effort has kept (Stage 2a's runtime protocol, Stage 3's display label).
 *
 * Layered as a Proxy around the real driver, the SAME technique `withRuntimeProtocol` uses and
 * for the same reason: `services/protocols/src/casambi/*` — the discovery engine, the command
 * engine, the Local UDP transport and codec — is completely untouched. It only ever sees bare
 * `casambi:<unitId>` addresses, exactly as it always has; this wrapper translates at the boundary,
 * not inside the driver package. Only `discover()` (rewrites outgoing backendIds) and `bind()`
 * (rewrites an incoming scoped address back to bare) need interception — `command()`/`manages()`/
 * `getState()`/`unbind()` are already keyed by Supreme `deviceId`, never by address, so they need
 * no translation at all.
 */
export function withCasambiInstanceAddressing<T extends INativeProtocolDriver>(driver: T, instanceId: string | null): T {
  if (!instanceId) return driver;
  return new Proxy(driver, {
    get(target, prop, receiver) {
      if (prop === "discover") {
        return async (): Promise<DiscoveredDevice[]> => {
          const found = await target.discover();
          return found.map((d) =>
            d.backendId.startsWith(CASAMBI_PREFIX) ? { ...d, backendId: scopeCasambiBackendId(d.backendId, instanceId) } : d,
          );
        };
      }
      if (prop === "bind") {
        return async (binding: ProtocolBinding): Promise<void> =>
          target.bind({ ...binding, address: unscopeCasambiBackendId(binding.address, instanceId) });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Build a native driver instance for a protocol from stored config; null if unsupported/unconfigured.
 * `ctx.onLog`, when given, surfaces the driver's connection lifecycle (connect/error) into the
 * Extension Center's per-driver log and the system-wide Logs page — without it a socket that never
 * connects to a bound device (a real Denon/HEOS/Yamaha unit, say) fails completely silently. */
export function buildNativeDriver(protocol: string, config: Record<string, unknown>, ctx: NativeDriverFactoryContext = {}): INativeProtocolDriver | null {
  const factory = NATIVE_DRIVER_FACTORIES[protocol];
  return factory ? factory(config, ctx) : null;
}

/** Protocols that CAN be instantiated at runtime from a manifest (the rest are managed by the backend). */
export function hasNativeFactory(protocol: string): boolean {
  return protocol in NATIVE_DRIVER_FACTORIES;
}
