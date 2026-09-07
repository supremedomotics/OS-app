import { createContext, useContext } from "react";

/** deviceId → capabilityKind → latest normalized state (live deltas + optimistic). */
export type LiveStates = Record<string, Record<string, unknown>>;

/** § Realtime State Architecture — a driver's CONNECTION state (is the live link up),
 * distinct from device capability values above. Command state ("connecting"/
 * "disconnecting") vs actual confirmed state ("connected"/"disconnected"/"error") are
 * both carried here so no component ever has to treat a request as equivalent to
 * successful execution. */
export type DriverConnectionState = "disconnected" | "connecting" | "connected" | "disconnecting" | "error";
export interface DriverLiveState {
  state: DriverConnectionState;
  error?: string | null;
  ts: string;
}
/** driverId (installedId) → latest known connection state. */
export type LiveDriverStates = Record<string, DriverLiveState>;

export const LiveContext = createContext<{
  states: LiveStates;
  apply: (deviceId: string, capability: string, state: unknown) => void;
  driverStates: LiveDriverStates;
  applyDriverState: (driverId: string, state: DriverConnectionState, error?: string | null, ts?: string) => void;
}>({ states: {}, apply: () => {}, driverStates: {}, applyDriverState: () => {} });

export const useLive = () => useContext(LiveContext);
