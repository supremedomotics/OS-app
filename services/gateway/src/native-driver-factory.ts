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

/**
 * Native driver factories — the manifest↔runtime bridge. Given a driver's PROTOCOL and its stored
 * config (from the manifest config schema), build the matching {@link INativeProtocolDriver}. This is
 * how an installed + enabled + configured driver becomes a live protocol stack, instead of the old
 * env-only wiring in bootstrap.ts. A protocol with no factory (or missing required config) yields
 * null and simply isn't brought up at runtime.
 */
export type DriverLogFn = (level: "info" | "warn" | "error", message: string) => void;
export type NativeDriverFactory = (config: Record<string, unknown>, onLog?: DriverLogFn) => INativeProtocolDriver | null;

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const int = (v: unknown, fallback: number): number => {
  const n = typeof v === "number" ? v : v !== undefined && v !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

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
  casambi: (c) => {
    const apiKey = str(c.apiKey);
    const email = str(c.email);
    const password = str(c.password);
    if (!apiKey || !email || !password) return null;
    const networkId = str(c.networkId);
    return new CasambiProtocolDriver({
      credentials: { apiKey, email, password, ...(networkId ? { networkId } : {}) },
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
  avr: (c, onLog) => new AvrProtocolDriver({ onLog, trace: c.trace === true }),
  heos: (c, onLog) => new HeosProtocolDriver({ onLog, trace: c.trace === true }),
  yamaha: (c, onLog) => new YamahaProtocolDriver({ onLog, trace: c.trace === true }),
};

/** Build a native driver instance for a protocol from stored config; null if unsupported/unconfigured.
 * `onLog`, when given, surfaces the driver's connection lifecycle (connect/error) into the Extension
 * Center's per-driver log and the system-wide Logs page — without it a socket that never connects to
 * a bound device (a real Denon/HEOS/Yamaha unit, say) fails completely silently. */
export function buildNativeDriver(protocol: string, config: Record<string, unknown>, onLog?: DriverLogFn): INativeProtocolDriver | null {
  const factory = NATIVE_DRIVER_FACTORIES[protocol];
  return factory ? factory(config, onLog) : null;
}

/** Protocols that CAN be instantiated at runtime from a manifest (the rest are managed by the backend). */
export function hasNativeFactory(protocol: string): boolean {
  return protocol in NATIVE_DRIVER_FACTORIES;
}
