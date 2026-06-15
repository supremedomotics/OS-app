import { createContext, useContext } from "react";

/** deviceId → capabilityKind → latest normalized state (live deltas + optimistic). */
export type LiveStates = Record<string, Record<string, unknown>>;

export const LiveContext = createContext<{
  states: LiveStates;
  apply: (deviceId: string, capability: string, state: unknown) => void;
}>({ states: {}, apply: () => {} });

export const useLive = () => useContext(LiveContext);
