import { AvrProtocolDriver } from "@supreme/protocols";
import { newId, type DeviceId } from "@supreme/domain-model";
import type { ProbeResult, ProbeZone } from "@supreme/contracts";

const PROBE_TIMEOUT_MS = 3_500;
const POLL_INTERVAL_MS = 200;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A real, targeted reachability + best-effort zone probe for a user-typed AVR IP (§ AVR
 * Intelligent Manual Add). Spins up a throwaway `AvrProtocolDriver` instance — never touches
 * the SIL's live driver managing real commissioned devices — binds main + zone2 to the same
 * address (one TCP connection; a single init burst answers both), waits a bounded window for
 * real wire responses, then tears itself down completely. Reuses `TcpLineTransport`/
 * `avr-codec`/`DriverDiagnosticsTracker` as-is; this is a thin orchestration layer, not a
 * second transport.
 *
 * Zone 2 "detected" is honestly a heuristic, not a real capability query — Denon/Marantz's
 * classic Telnet protocol has no feature-query command (see avr-codec.ts's module doc). A
 * unit that's slow to answer within the window may show as "not detected" even though Zone 2
 * exists — callers must present this as editable, never authoritative.
 */
export async function probeAvr(address: string): Promise<ProbeResult> {
  const driver = new AvrProtocolDriver();
  const mainId = newId("device") as DeviceId;
  const zone2Id = newId("device") as DeviceId;
  try {
    await driver.connect();
    await driver.bind({ deviceId: mainId, capability: "onoff", address, config: { zone: "main" } });
    await driver.bind({ deviceId: zone2Id, capability: "onoff", address, config: { zone: "zone2" } });

    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let diag = driver.getDiagnostics(mainId);
    while (Date.now() < deadline && diag?.connectionStatus !== "connected" && !diag?.lastError) {
      await sleep(POLL_INTERVAL_MS);
      diag = driver.getDiagnostics(mainId);
    }

    const reachable = diag?.connectionStatus === "connected";
    const zones: ProbeZone[] = reachable
      ? [
          { id: "main", label: "Zone 1", detected: true },
          { id: "zone2", label: "Zone 2", detected: driver.getState(zone2Id, "onoff") !== null },
        ]
      : [];

    return {
      reachable,
      error: reachable
        ? null
        : (diag?.lastError ??
          "No response within the timeout — check the IP and that Network Control/Telnet is enabled on the receiver."),
      mac: diag?.mac ?? null,
      zones,
    };
  } finally {
    await driver.unbind(mainId);
    await driver.unbind(zone2Id);
    await driver.disconnect();
  }
}
