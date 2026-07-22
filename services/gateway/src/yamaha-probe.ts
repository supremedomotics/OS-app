import { YamahaProtocolDriver } from "@supreme/protocols";
import { newId, type DeviceId } from "@supreme/domain-model";
import type { ProbeResult } from "@supreme/contracts";

const PROBE_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real, targeted reachability + zone probe for a user-typed Yamaha unit IP (§ AVR/Yamaha
 * Intelligent Manual Add). Unlike AVR's best-effort zone2 heuristic, Yamaha's zone list is a
 * genuine wire query — `bind()` itself awaits a real `/system/getFeatures` fetch (via
 * `ensureHostFeatures()`), so a successful bind means the returned zones are exactly what the
 * unit reported, not a guess. Model/manufacturer stay honestly `null` here: those come from
 * the UPnP description XML fetched during a broadcast SSDP discover() (a real `location` URL
 * the unit announces), which a manually-typed IP with no discovery step never has access to —
 * the same reason AVR's manual probe can't report them either.
 */
export async function probeYamaha(address: string): Promise<ProbeResult> {
  const driver = new YamahaProtocolDriver();
  const mainId = newId("device") as DeviceId;
  try {
    await driver.connect();
    await Promise.race([
      driver.bind({ deviceId: mainId, capability: "onoff", address, config: { zone: "main" } }),
      sleep(PROBE_TIMEOUT_MS).then(() => {
        throw new Error("No response within the timeout — check the IP and that the unit is a Yamaha AVR/MusicCast device.");
      }),
    ]);
    const zones = driver.getHostZones(address);
    if (!zones || zones.length === 0) {
      return { reachable: false, error: "Connected, but this unit reported no zones.", mac: null, zones: [] };
    }
    const diag = driver.getDiagnostics(mainId);
    return {
      reachable: true,
      error: null,
      mac: diag?.mac ?? null,
      zones: zones.map((z) => ({ id: z.id, label: z.label, detected: true })),
    };
  } catch (e) {
    return {
      reachable: false,
      error: e instanceof Error ? e.message : "Could not reach this address.",
      mac: null,
      zones: [],
    };
  } finally {
    await driver.unbind(mainId);
    await driver.disconnect();
  }
}
