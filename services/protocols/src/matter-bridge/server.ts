/**
 * Matter Bridge server transport seam (§ Matter Bridge Phase 1). Mirrors `MatterController`'s
 * existing pattern in `matter-driver.ts`: production wiring is a real `@matter/main`
 * `ServerNode` (see `real-server.ts`), kept behind this interface so the Bridge's endpoint-
 * mapping and command-routing logic is unit-testable without opening real UDP/mDNS sockets —
 * this sandbox has no LAN path to a real ecosystem, so that is the honest boundary of what
 * can be verified here (§29: NOT VERIFIED — REQUIRES REAL HARDWARE / ECOSYSTEM covers real
 * commissioning + real Apple/Google/Alexa/SmartThings interop).
 */
export interface MatterBridgeServer {
  start(): Promise<void>;
  stop(): Promise<void>;

  /** Add one bridged On/Off Light endpoint at a SPECIFIC, caller-assigned endpoint number
   * (the `MatterEndpointRegistry`'s persisted allocation — never left to the server to pick,
   * so identity survives restart). Idempotent: re-adding the same endpoint number on a
   * subsequent boot must not throw. */
  addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void>;

  /** Remove a previously-added endpoint (device unbridged/deleted). */
  removeEndpoint(endpointNumber: number): Promise<void>;

  /** Write the On/Off attribute for an endpoint — a STATE REPORT, not a command. Must never
   * itself invoke the server's own command handler (that would be the feedback loop §11
   * explicitly warns about); a real Matter attribute write is not a command re-entry, only a
   * genuine ecosystem-issued On/Off cluster invocation is. */
  setOnOffState(endpointNumber: number, on: boolean): Promise<void>;

  /** Fires once per genuine On/Off cluster command the server received from a Matter
   * controller (Apple/Google/Alexa/a test controller/…). Returns an unsubscribe function. */
  onCommand(listener: (endpointNumber: number, on: boolean) => void): () => void;
}
