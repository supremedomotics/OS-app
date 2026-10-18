/**
 * Single-slot connection factory (§ Clean-room KNX stack — reconnect ownership, Stage 1, rule 3). `KnxProtocolDriver.connect()` builds a NEW connection
 * through `createConnection` every time and cannot cancel one that is still connecting (`disconnect()` is a no-op until `connect()` has resolved,
 * because the driver only keeps the connection after it succeeded). If the driver is replaced meanwhile (the engine's unregister + register on a
 * config change) the old connection would finish connecting later and a second tunnel would sit on a gateway that may allow one.
 * This factory makes "one live NativeKnxConnection per factory" structural: creating the next connection first disconnects its predecessor, which
 * cancels a still-connecting one (its connect() rejects `closed`, its half-open tunnel is closed orderly) and closes a live one.
 * It does not fix the driver's own race (a disconnect() issued during its own in-flight connect still lets that connect finish and be kept) — that
 * needs a driver change and is recorded in docs/knx/knx-reconnect-ownership.md. Not wired into any production path.
 */
import type { KnxConnection } from "../../knx-driver.js";
import type { NativeKnxConnection } from "./knx-connection.js";

export function createSingleSlotConnectionFactory(make: (o: { host: string; port: number }) => NativeKnxConnection): (o: { host: string; port: number }) => Promise<KnxConnection> {
  let current: NativeKnxConnection | null = null;
  return async (o) => {
    const previous = current;
    const next = make(o);
    current = next;
    if (previous) await previous.disconnect();
    return next;
  };
}
