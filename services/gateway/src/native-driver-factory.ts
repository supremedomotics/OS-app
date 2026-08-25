import type { INativeProtocolDriver } from "@supreme/integration-layer";
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
   * NETWORK_ID env vars (config.ts), present only when all three required fields are set at
   * deployment time. Used as a FALLBACK by the `casambi` factory's Cloud branch when this
   * driver instance's own manifest config leaves apiKey/email/password blank, so an installer
   * never has to type them if the deployment already has a fleet default configured — the same
   * env vars that already auto-connect Cloud mode with zero UI input via bootstrap.ts's
   * separate `envDrivers` path, now also backing the manifest-driven install path. Never a
   * literal credential in source — only ever read from the running deployment's own
   * environment/secrets. */
  casambiCloudDefaults?: { apiKey: string; email: string; password: string; networkId?: string };
}
export type NativeDriverFactory = (config: Record<string, unknown>, ctx: NativeDriverFactoryContext) => INativeProtocolDriver | null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : v !== undefined && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

/** § Casambi fleet-wide default account — shared by the `casambi` factory's Cloud branch below
 * and `routes/installer.ts`'s `/casambi/sync-names` route (Local Gateway's one-time Cloud name
 * sync), so the same driver-config-then-fleet-default precedence isn't duplicated in two places.
 * `config` is a driver instance's own stored config; `defaults` is `casambiCloudDefaults` (present
 * only when SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD are all set at deployment time). Returns null
 * when neither source has all three required fields. */
export function resolveCasambiCloudCredentials(
  config: Record<string, unknown>,
  defaults?: { apiKey: string; email: string; password: string; networkId?: string },
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
