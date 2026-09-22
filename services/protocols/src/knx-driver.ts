import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
  HvacStatus,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import {
  decodeHeatCool,
  decodeHvacControllingMode,
  decodeHvacOperatingMode,
  decodeHvacSetpoints,
  decodeHvacStatus,
  defaultDpt,
  encodeHeatCool,
  encodeHvacOperatingMode,
  stateFromValue,
  valueFromCommand,
  type KnxValue,
} from "./knx-codec.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { colorModesFromDpt } from "./knx/capability-mapper.js";

/**
 * KNXnet/IP transport seam. A real KNXnet/IP connection (tunnelling or routing) is
 * injected or loaded from `knxultimate`; this keeps the byte-level DPT framing in
 * the transport and lets the driver be unit-tested against a fake bus.
 */
export interface KnxConnection {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** Group-write a decoded value to a group address with the given DPT. */
  write(groupAddress: string, value: KnxValue, dpt: string): Promise<void>;
  /** Observe a status group address (decoded per DPT); handler runs on each update.
   * Returns an unsubscribe function (§ Driver Lifecycle Completion — every driver's
   * per-binding observer must be releasable without tearing down the whole bus
   * connection, since other bindings may still be observing other group addresses). */
  observe(groupAddress: string, dpt: string, handler: (value: KnxValue) => void): () => void;
}

export interface KnxDriverOptions {
  /** KNXnet/IP gateway host (tunnelling) or multicast group (routing). */
  host: string;
  port?: number;
  /** Injectable transport (tests pass a fake bus; prod loads `knxultimate`). */
  createConnection?: (opts: { host: string; port: number }) => Promise<KnxConnection>;
}

/** (§ Phase 3.3B/3.3C-2 — KNX HVAC Multi-GA Entity/Binding Architecture) One additional
 * group address belonging to the SAME entity as its parent `KnxBinding`, tagged with a
 * semantic role independent of DPT number (e.g. "operatingMode", "controllingModeExtended").
 * Tracked and subscribed exactly like the primary binding's `statusGa`. A role with no
 * real decoder wired yet keeps `decodedValue` permanently `null` — `rawValue` alone is
 * enough to prove the architecture is wired end-to-end (discovery → persistence →
 * restart → read → feedback) without fabricating a decoded meaning for a DPT this driver
 * doesn't understand. */
interface KnxHvacRoleBinding {
  semanticRole: string;
  address: string;
  dpt: string;
  rawValue: KnxValue | null;
  /** (§ Phase 3.3C-1/3.3C-2/3.3C-4/3.3C-5B) The last successfully DECODED value for this
   * role, via {@link decodeHvacRoleValue} — generic across every semantic role, not just
   * "operatingMode" (see that function for the per-role dispatch table). A role decoding
   * to a single enum token (operatingMode/controllingModeExtended/heatCool) stores a
   * `string`; "status" and "setpoints" (§ Phase 3.3C-4/3.3C-5B — DPT 22.101/222.100 are
   * each a multi-field COMPLETE snapshot per telegram, not a single value) store the
   * whole decoded object instead. Kept separately from `rawValue` and from
   * `KnxProtocolDriver.states` itself so it survives independently of whether a primary
   * temperature reading has arrived yet, and so a fresh primary reading can always
   * re-merge it in (see `applyHvacRoleOverlay`) instead of silently clobbering it. `null`
   * until a valid value has been observed, or after an invalid/reserved value is ignored
   * (§ "never fabricate" — an invalid telegram never overwrites a previously-good one,
   * but it also never magically produces one where none existed). */
  decodedValue: string | HvacStatus | HvacSetpoints | null;
  unsubscribe?: () => void;
}

/** `TemperatureState.setpoints`'s shape, re-derived from the universal schema rather
 * than duplicated by hand (matches the identical alias in `knx-codec.ts`). */
type HvacSetpoints = NonNullable<Extract<CapabilityState, { kind: "temperature" }>["setpoints"]>;

/** (§ Phase 3.3C-1/3.3C-2/3.3C-4/3.3C-5B) Per-semantic-role decode dispatch — the ONE
 * place that maps a `KnxHvacRoleBinding.semanticRole` to its real DPT decoder. Adding a
 * future role (once its own DPT phase lands) is exactly one new `case`, never a new
 * overlay/merge mechanism (§ "do not duplicate overlay/state-merging logic" — Phase
 * 3.3C-2 spec §7). A role with no case yet (or an out-of-range raw value) returns `null`
 * — never fabricated. */
function decodeHvacRoleValue(semanticRole: string, value: KnxValue): string | HvacStatus | HvacSetpoints | null {
  switch (semanticRole) {
    case "operatingMode":
      return decodeHvacOperatingMode(value);
    case "controllingModeExtended":
      return decodeHvacControllingMode(value);
    case "heatCool":
      return decodeHeatCool(value);
    case "status":
      return decodeHvacStatus(value);
    case "setpoints":
      return decodeHvacSetpoints(value);
    default:
      return null;
  }
}

interface KnxBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  /** Group address commands are written to. */
  writeGa: string;
  /** Group address status is read from (defaults to writeGa). */
  statusGa: string;
  dpt: string;
  config: Record<string, unknown>;
  unsubscribe?: () => void;
  /** (§ Phase 3.3B) Additional same-entity GAs, keyed by semantic role — see
   * {@link KnxHvacRoleBinding}. Empty array when the binding config carries none
   * (the overwhelming majority of bindings, and every non-`temperature` capability
   * today), never `undefined`, so callers never need an extra null-check. */
  hvacRoles: KnxHvacRoleBinding[];
}

/** Parses `config.hvacRoles` (a plain `{semanticRole: {address, dpt?}}` object, as
 * `entity-generator.ts` produces it) into the driver's internal array. Malformed/missing
 * entries are skipped, never thrown — a binding config authored by hand or from an older
 * commissioning pass without this field must still bind normally (§ backward
 * compatibility). */
function parseHvacRoles(cfg: Record<string, unknown>, defaultDptValue: string): KnxHvacRoleBinding[] {
  const raw = cfg.hvacRoles;
  if (!raw || typeof raw !== "object") return [];
  const out: KnxHvacRoleBinding[] = [];
  for (const [semanticRole, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object") continue;
    const address = (entry as Record<string, unknown>).address;
    if (typeof address !== "string" || address.length === 0) continue;
    const dpt = (entry as Record<string, unknown>).dpt;
    out.push({ semanticRole, address, dpt: typeof dpt === "string" ? dpt : defaultDptValue, rawValue: null, decodedValue: null });
  }
  return out;
}

/**
 * Real KNXnet/IP protocol driver (§3, §7) — KNX is the backbone of high-end European
 * installs (lighting, blinds, HVAC). Commands are KNX group-writes; device status is
 * observed on (often separate) status group addresses. The driver confines all KNX
 * framing and emits pure Supreme capabilities upward.
 */
export class KnxProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "knx";
  private conn: KnxConnection | null = null;
  private readonly opts: KnxDriverOptions;
  private readonly bindings: KnxBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly states = new Map<string, CapabilityState>();
  private readonly listeners = new Set<StateListener>();

  constructor(opts: KnxDriverOptions) {
    this.opts = opts;
  }

  async connect(): Promise<void> {
    if (this.conn) return;
    const factory = this.opts.createConnection ?? defaultKnxConnection;
    const conn = await factory({ host: this.opts.host, port: this.opts.port ?? 3671 });
    // § Real production bug: `this.conn` was previously assigned before `conn.connect()`
    // was confirmed to succeed. A failed connect (e.g. a KNXnet/IP gateway rejecting with
    // "No More Connections") left `this.conn` truthy anyway, so every subsequent connect()
    // call — including an auto-retry — silently no-op'd via the `if (this.conn) return;`
    // guard above, and isConnected() (which also just checks nullness) wrongly reported
    // connected. Only assign `this.conn` once `connect()` has actually succeeded, so a
    // failed attempt leaves the driver honestly disconnected and retryable.
    await conn.connect();
    this.conn = conn;
    for (const b of this.bindings) this.observe(b);
  }

  async disconnect(): Promise<void> {
    await this.conn?.disconnect();
    this.conn = null;
  }

  isConnected(): boolean {
    return this.conn !== null;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const cfg = binding.config ?? {};
    const dpt = typeof cfg.dpt === "string" ? cfg.dpt : defaultDpt(binding.capability as CapabilityState["kind"]);
    const entry: KnxBinding = {
      deviceId: binding.deviceId,
      capability: binding.capability,
      writeGa: binding.address,
      statusGa: typeof cfg.statusAddress === "string" ? cfg.statusAddress : binding.address,
      dpt,
      config: cfg,
      hvacRoles: parseHvacRoles(cfg, dpt),
    };
    this.bindings.push(entry);
    this.devices.add(binding.deviceId);
    if (this.conn) this.observe(entry);
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § live-confirmed fix — this is the driver actually bound to a real KNX bus in
   * production (`bootstrap.ts` wires it from `config.knxHost`); `SupremeKnxDriver`'s
   * own `getCapabilityConfig` (same logic, duplicated here) only backs the discovery/
   * scan pipeline, never live commands, so its colorModes evidence never reached a real
   * device's persisted capability config — `InstallerServices.bindProtocol` calls
   * THIS driver's `getCapabilityConfig` right after binding, and with no implementation
   * here it silently fell back to `null`, leaving every KNX color capability's `config`
   * permanently `{}` regardless of what the scan/binding correctly computed. See
   * `colorModesFromDpt`'s own doc comment for the DPT-major evidence rule. */
  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "color") return null;
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "color");
    if (!b) return null;
    const modes = colorModesFromDpt(b.dpt);
    return modes ? { colorModes: modes } : null;
  }

  /** § Driver Lifecycle Completion — unsubscribes this device's group-address
   * observer(s) from the shared bus connection (previously leaked: the closure kept
   * firing and re-populating state for an "unbound" device forever), then releases its
   * bindings/cached state. Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    for (const b of this.bindings) {
      if (b.deviceId !== deviceId) continue;
      b.unsubscribe?.();
      for (const r of b.hvacRoles) r.unsubscribe?.();
    }
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    if (!this.conn) throw new Error("knx: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`knx: ${deviceId} not bound for ${command.capability}`);

    // § Phase 3.3C-1 — `operatingMode` (DPT 20.102) routes to its OWN hvacRoles GA,
    // NEVER the primary temperature GA, and is handled independently of the existing
    // targetC/mode write path below. Deliberately NOT optimistically recorded (§8 of the
    // Phase 3.3C-1 spec — "do not force state to Comfort merely because the command was
    // sent"): unlike every other write in this driver, the cached `operatingMode` only
    // ever updates from a real KNX feedback telegram (see `observe()`), never from the
    // command that requested it.
    let wroteOperatingMode = false;
    if (command.capability === "temperature" && command.operatingMode !== undefined) {
      const role = b.hvacRoles.find((r) => r.semanticRole === "operatingMode");
      if (!role) throw new Error(`knx: ${deviceId} has no "operatingMode" HVAC role bound for temperature`);
      await this.conn.write(role.address, encodeHvacOperatingMode(command.operatingMode), role.dpt);
      wroteOperatingMode = true;
    }

    // § Phase 3.3C-3 — `heatCool` (DPT 1.100) routes to its OWN hvacRoles GA, exactly
    // like `operatingMode` above: never the primary temperature GA, never the
    // operatingMode/controllingMode GAs, and deliberately NOT optimistically recorded —
    // only real KNX feedback (see `observe()`) ever updates the cached `heatCool` value
    // (§9 of the Phase 3.3C-3 spec — feedback wins over the requested value).
    let wroteHeatCool = false;
    if (command.capability === "temperature" && command.heatCool !== undefined) {
      const role = b.hvacRoles.find((r) => r.semanticRole === "heatCool");
      if (!role) throw new Error(`knx: ${deviceId} has no "heatCool" HVAC role bound for temperature`);
      await this.conn.write(role.address, encodeHeatCool(command.heatCool), role.dpt);
      wroteHeatCool = true;
    }

    // Existing targetC/targetLowC/targetHighC write path — byte-for-byte unchanged, EXCEPT
    // it is now skipped entirely for a temperature command that carries ONLY
    // `operatingMode`/`heatCool` (nothing here to write to the primary GA, and writing
    // anyway would silently re-send whatever `targetC` the primary binding cached last —
    // a real accidental write this guard exists specifically to prevent).
    //
    // § Phase 3.3D-FIX — `mode`/`advanced` deliberately do NOT count toward "has a
    // writable payload" here: this driver has no KNX DPT mapping for either concept at
    // the primary-GA level (no invented `mode`→operatingMode/controllingModeExtended
    // mapping — those are genuinely different KNX concepts, see their own doc comments),
    // so a command carrying ONLY `mode` and/or `advanced` used to silently fall through
    // to this write path anyway (via the old, broader OR condition), re-sending whatever
    // `targetC`/`ambientC` was already cached as a real, unrequested KNX write, while the
    // actual request was discarded with no error. That command is now REJECTED outright
    // (see below) rather than silently swallowed or given an invented mapping. `mode`/
    // `advanced` combined with a real writable field (targetC/targetLowC/targetHighC)
    // still succeeds exactly as before — only the alone case changes.
    const hasWritableTemperaturePayload =
      command.capability !== "temperature" ||
      command.targetC !== undefined ||
      command.targetLowC !== undefined ||
      command.targetHighC !== undefined;
    if (!hasWritableTemperaturePayload) {
      if (wroteOperatingMode || wroteHeatCool) return;
      throw new Error(
        `knx: ${deviceId} sent a temperature command with no writable payload — "mode"/"advanced" alone have no KNX write mapping on this driver; provide targetC, targetLowC, targetHighC, operatingMode, or heatCool`,
      );
    }

    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const value = valueFromCommand(command, prev, b.dpt);
    if (value === null) throw new Error(`knx: unsupported command for ${command.capability}`);
    await this.conn.write(b.writeGa, value, b.dpt);
    // Optimistically reflect the command; a status telegram will confirm/correct it.
    // § Phase 3.3C-1 — re-apply the hvacRoles overlay here too, for the same reason as
    // `observe()`'s primary handler: this optimistic write must not silently clobber a
    // previously-decoded `operatingMode` back to `undefined`.
    const optimistic = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
    if (optimistic) this.record(b, this.applyHvacRoleOverlay(b, optimistic));
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // KNX has no device discovery without an ETS project import; devices are
    // commissioned explicitly from their group-address map.
    return [];
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private observe(b: KnxBinding): void {
    if (!this.conn) return;
    b.unsubscribe = this.conn.observe(b.statusGa, b.dpt, (value) => {
      const state = stateFromValue(b.capability as CapabilityState["kind"], value, b.config);
      // § Phase 3.3C-1 fix — `stateFromValue` always returns a FRESH object built only
      // from this one telegram; without re-applying the hvacRoles overlay here, a new
      // ambient/setpoint reading would silently clobber a previously-decoded
      // `operatingMode` back to `undefined` even though nothing about the mode changed.
      if (state) this.record(b, this.applyHvacRoleOverlay(b, state));
    });
    // § Phase 3.3B — each auxiliary HVAC-role GA gets its OWN subscription, independent
    // of the primary binding's statusGa, so restart/reconnect re-establishes every one of
    // them (§ restart/recovery) exactly like the primary GA already does. The raw value
    // is always stored (see getHvacRoleValue); a role is ADDITIONALLY decoded into
    // typed `TemperatureState` fields only if `decodeHvacRoleValue` has a real DPT
    // decoder for it (currently "operatingMode"/20.102 and "controllingModeExtended"/
    // 20.105 — § Phase 3.3C-1/3.3C-2) — every other role stays raw-only until its own DPT
    // is implemented in a later phase.
    for (const r of b.hvacRoles) {
      r.unsubscribe = this.conn!.observe(r.address, r.dpt, (value) => {
        r.rawValue = value;
        const decoded = decodeHvacRoleValue(r.semanticRole, value);
        // § "never fabricate KNX semantics" — a reserved/out-of-range value (or a role
        // with no decoder at all) is IGNORED, never mapped to a fabricated fallback; the
        // cached decoded value (if any) simply stays whatever it last validly was.
        if (decoded === null) return;
        r.decodedValue = decoded;
        const prev = this.states.get(bindingKey(b.deviceId, "temperature"));
        // No primary temperature reading exists yet to merge into — `ambientC`/`mode`
        // are mandatory fields this driver will not fabricate just to carry a role
        // update. `r.decodedValue` is still remembered above, so the merge happens
        // automatically the moment the primary GA's own handler (above) fires for the
        // first time — never lost, never fabricated in the meantime.
        if (prev?.kind !== "temperature") return;
        this.record(b, this.applyHvacRoleOverlay(b, prev));
      });
    }
  }

  /** (§ Phase 3.3C-1/3.3C-2) Re-applies every hvacRoles-derived field this binding has a
   * real, previously-decoded value for onto a freshly-computed `CapabilityState` — the
   * fix for `stateFromValue`'s fresh-object-per-telegram behavior otherwise clobbering
   * hvacRoles data on every unrelated primary-GA update (or on another role's own
   * update — each role's decoded value survives independently of every other's).
   * GENERIC across roles (§ "do not duplicate overlay/state-merging logic" — Phase
   * 3.3C-2 spec §7): iterates every bound role once, rather than one hand-written `if`
   * per role. Adding a future role's typed field is one line in the switch below, never
   * a new overlay mechanism. */
  private applyHvacRoleOverlay(b: KnxBinding, state: CapabilityState): CapabilityState {
    if (state.kind !== "temperature") return state;
    let result = state;
    for (const r of b.hvacRoles) {
      if (r.decodedValue === null) continue;
      switch (r.semanticRole) {
        case "operatingMode":
          result = { ...result, operatingMode: r.decodedValue as ReturnType<typeof decodeHvacOperatingMode> };
          break;
        case "controllingModeExtended":
          result = { ...result, controllingModeExtended: r.decodedValue as string };
          break;
        case "heatCool":
          result = { ...result, heatCool: r.decodedValue as ReturnType<typeof decodeHeatCool> };
          break;
        case "status":
          // § Phase 3.3C-4 §10 — REPLACE, never merge: each DPT 22.101 telegram is a
          // complete status snapshot, so the previously-decoded status object is dropped
          // wholesale in favor of this one, exactly like every other role here already
          // replaces (never merges into) its own single typed field.
          result = { ...result, status: r.decodedValue as HvacStatus };
          break;
        case "setpoints":
          // § Phase 3.3C-5B §9/§10 — REPLACE, never merge: DPT 222.100 is a complete
          // Comfort/Standby/Economy snapshot per telegram, same discipline as "status".
          result = { ...result, setpoints: r.decodedValue as HvacSetpoints };
          break;
        default:
          break; // a role with no typed TemperatureState field yet — raw-only, nothing to overlay
      }
    }
    return result;
  }

  /** (§ Phase 3.3B) The last-known RAW value observed on an auxiliary HVAC-role GA, or
   * `null` if unbound/never observed. Deliberately raw/undecoded — see
   * {@link KnxHvacRoleBinding}'s doc comment. Test/diagnostic surface, not part of the
   * `INativeProtocolDriver` interface. */
  getHvacRoleValue(deviceId: DeviceId, capability: CapabilityKind, semanticRole: string): KnxValue | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === capability);
    return b?.hvacRoles.find((r) => r.semanticRole === semanticRole)?.rawValue ?? null;
  }

  /** (§ Phase 3.3B) Writes a raw value directly to an auxiliary HVAC-role GA's own
   * address — proves the architecture can target the CORRECT group address for a given
   * semantic role, independent of the primary binding's `writeGa`. Deliberately takes an
   * already-encoded `KnxValue`, not a `CapabilityCommand`: encoding a real command value
   * for e.g. "operatingMode" requires the DPT 20.102 semantics this phase does not
   * implement. Throws if the device/capability/role isn't bound or the bus isn't
   * connected — same failure discipline as `command()`. */
  async writeHvacRole(deviceId: DeviceId, capability: CapabilityKind, semanticRole: string, value: KnxValue): Promise<void> {
    if (!this.conn) throw new Error("knx: not connected");
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === capability);
    const r = b?.hvacRoles.find((x) => x.semanticRole === semanticRole);
    if (!r) throw new Error(`knx: ${deviceId} has no "${semanticRole}" HVAC role bound for ${capability}`);
    await this.conn.write(r.address, value, r.dpt);
  }

  private record(b: KnxBinding, state: CapabilityState): void {
    const k = bindingKey(b.deviceId, b.capability);
    const prev = this.states.get(k);
    if (prev && JSON.stringify(prev) === JSON.stringify(state)) return;
    this.states.set(k, state);
    for (const l of this.listeners) {
      l({ deviceId: b.deviceId, capability: b.capability, state, ts: new Date().toISOString() });
    }
  }
}

/** Default transport backed by `knxultimate` (KNXnet/IP tunnelling over UDP). */
async function defaultKnxConnection(opts: { host: string; port: number }): Promise<KnxConnection> {
  const moduleName = "knxultimate";
  const imported = (await import(moduleName)) as unknown as KnxUltimateModule;
  const runtime = (imported.default ?? imported) as KnxUltimateModule;
  const Client = imported.KNXClient ?? runtime.KNXClient;
  const dptlib = imported.dptlib ?? runtime.dptlib;
  if (!Client || !dptlib) throw new Error("knx: knxultimate did not expose KNXClient and dptlib");

  const client = new Client({
    hostProtocol: "TunnelUDP",
    ipAddr: opts.host,
    ipPort: opts.port,
  });
  return wrapKnxUltimate(client, dptlib);
}

interface KnxUltimateModule {
  default?: KnxUltimateModule;
  KNXClient?: new (opts: Record<string, unknown>) => KnxUltimateClient;
  dptlib?: KnxUltimateDptLib;
}

interface KnxUltimateClient {
  Connect(): void;
  Disconnect(): Promise<void>;
  write(groupAddress: string, value: KnxValue, dpt: string): void;
  on(event: "connected", cb: () => void): KnxUltimateClient;
  on(event: "error", cb: (err: unknown) => void): KnxUltimateClient;
  on(event: "indication", cb: (packet: KnxUltimateIndication) => void): KnxUltimateClient;
  off(event: "connected", cb: () => void): KnxUltimateClient;
  off(event: "error", cb: (err: unknown) => void): KnxUltimateClient;
}

interface KnxUltimateDptLib {
  resolve(dpt: string): unknown;
  fromBuffer(raw: Buffer, dptConfig: unknown): KnxValue;
}

interface KnxUltimateIndication {
  cEMIMessage?: {
    dstAddress?: { toString(): string };
    npdu?: {
      dataValue?: Buffer;
      isGroupWrite?: boolean;
      isGroupResponse?: boolean;
    };
  };
}

interface KnxUltimateObserver {
  dpt: string;
  handler: (value: KnxValue) => void;
}

function wrapKnxUltimate(client: KnxUltimateClient, dptlib: KnxUltimateDptLib): KnxConnection {
  const observers = new Map<string, KnxUltimateObserver[]>();
  client.on("indication", (packet) => {
    const cemi = packet.cEMIMessage;
    const dst = cemi?.dstAddress?.toString?.();
    const raw = cemi?.npdu?.dataValue;
    if (!dst || !raw) return;
    const handlers = observers.get(dst);
    if (!handlers?.length) return;
    for (const { dpt, handler } of handlers) {
      const value = dptlib.fromBuffer(raw, dptlib.resolve(dpt));
      handler(value);
    }
  });

  return {
    async connect() {
      await new Promise<void>((resolve, reject) => {
        // § Real production bug (instability found live, right after auto-retry started
        // calling connect() every 60s for a persistently-down driver): a FAILED attempt
        // here never released anything — the "connected"/"error" listeners stayed attached
        // forever, and whatever socket/timer `client.Connect()` had already opened before
        // failing was never torn down via `client.Disconnect()`. Repeated retries against a
        // driver that stays down (exactly KNX's "No More Connections" state) leaked one of
        // these per failed attempt, compounding over hours into the kind of slow resource
        // exhaustion that causes unrelated-looking symptoms (intermittent restarts —
        // clearing the in-memory system log, general sluggishness). Every path out of this
        // promise now removes its own listeners, and a failure explicitly disconnects the
        // client it just failed to bring up before rejecting.
        const onConnected = () => {
          cleanup();
          resolve();
        };
        const onError = (err: unknown) => {
          cleanup();
          void client.Disconnect().catch(() => {
            // best-effort — the client already failed to connect; nothing more to report.
          });
          reject(err instanceof Error ? err : new Error(String(err)));
        };
        const cleanup = () => {
          client.off("connected", onConnected);
          client.off("error", onError);
        };
        client.on("connected", onConnected);
        client.on("error", onError);
        client.Connect();
      });
    },
    async disconnect() {
      await client.Disconnect();
    },
    async write(ga, value, dpt) {
      client.write(ga, value, dpt);
    },
    observe(ga, dpt, handler) {
      const entry: KnxUltimateObserver = { dpt, handler };
      const handlers = observers.get(ga) ?? [];
      handlers.push(entry);
      observers.set(ga, handlers);
      return () => {
        const current = observers.get(ga);
        if (!current) return;
        const next = current.filter((o) => o !== entry);
        if (next.length === 0) observers.delete(ga);
        else observers.set(ga, next);
      };
    },
  };
}
