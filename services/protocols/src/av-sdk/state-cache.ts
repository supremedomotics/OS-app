import type { CapabilityKind, CapabilityState, DeviceId } from "@supreme/domain-model";
import { bindingKey, type StateListener } from "@supreme/integration-layer";

/**
 * SupremeOS Universal AV SDK (§ Universal AV SDK Architecture) — shared capability-state
 * record/dedupe/dispatch helper.
 *
 * Extracted from `record()`, which was 100% verbatim-identical across `AvrProtocolDriver`,
 * `HeosProtocolDriver`, and `YamahaProtocolDriver` before this extraction (confirmed by the
 * duplication audit — same variable names, same `JSON.stringify` dedupe check, same listener
 * dispatch shape). This is the lowest-risk extraction in the SDK: a pure function with no
 * closures over transport state, operating on whatever `Map`/listener set the caller already
 * owns — nothing about it is AV-specific, it's simply where the duplication was actually found.
 *
 * Deliberately NOT a stateful class owning its own `Map`/`Set` — each driver keeps its own
 * `states`/`listeners` fields exactly as before, so `getState()`, `onState()`, and each driver's
 * existing `unbind()`-time `removeDeviceStates()` cleanup call are untouched by this extraction.
 *
 * `traceId` (§ AVR Diagnostic Mode) — optional, purely additive: when a caller passes one
 * (only `AvrProtocolDriver`, only when diagnostics is enabled, does today), it rides on the
 * dispatched `BackendStateEvent` so gateway-layer code can append its own stage to the same
 * per-event trace. `undefined` for every other caller — zero behavior change.
 *
 * Returns whether the state actually changed (and was therefore dispatched to listeners) —
 * added so `AvrProtocolDriver`'s diagnostics can report an accurate `changed`/dedupe result
 * without re-implementing this function's own dedupe comparison a second time (which would
 * risk the two silently drifting apart). Existing callers that ignore the return value are
 * unaffected.
 */
export function recordCapabilityState(
  states: Map<string, CapabilityState>,
  listeners: Iterable<StateListener>,
  deviceId: DeviceId,
  capability: CapabilityKind,
  state: CapabilityState,
  traceId?: string,
): boolean {
  const k = bindingKey(deviceId, capability);
  const prev = states.get(k);
  if (prev && JSON.stringify(prev) === JSON.stringify(state)) return false;
  states.set(k, state);
  for (const l of listeners) {
    l({ deviceId, capability, state, ts: new Date().toISOString(), ...(traceId ? { traceId } : {}) });
  }
  return true;
}
