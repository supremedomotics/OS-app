import { Environment, ServerNode, Endpoint, VendorId, Logger, LogLevel } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffPlugInUnitDevice } from "@matter/main/devices/on-off-plug-in-unit";
import { GenericSwitchDevice } from "@matter/main/devices/generic-switch";
import { SwitchServer } from "@matter/main/behaviors/switch";
import { Switch } from "@matter/main/clusters/switch";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { ColorTemperatureLightDevice, ColorTemperatureLightRequirements } from "@matter/main/devices/color-temperature-light";
import { ExtendedColorLightDevice, ExtendedColorLightRequirements } from "@matter/main/devices/extended-color-light";
import { WindowCoveringDevice } from "@matter/main/devices/window-covering";
import { ThermostatDevice, ThermostatRequirements } from "@matter/main/devices/thermostat";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { LevelControlServer } from "@matter/main/behaviors/level-control";
import { WindowCoveringServer, MovementType, MovementDirection } from "@matter/main/behaviors/window-covering";
import { WindowCovering } from "@matter/main/clusters/window-covering";
import { ColorControl } from "@matter/main/clusters/color-control";
import { Thermostat } from "@matter/main/clusters/thermostat";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type { CapabilityCommand, CapabilityState } from "@supreme/domain-model";
import type { MatterBridgeServer, MatterBridgeCommissioningState, MatterBridgeFabricInfo, MatterBridgeEndpointSpec } from "./server.js";
import { levelToMatter, levelFromMatter } from "./clusters/level-control-adapter.js";
import {
  kelvinToMireds,
  miredsToKelvin,
  hueSaturationToXy,
  xyToHueSaturation,
  xyChannelToMatter,
  xyChannelFromMatter,
} from "./clusters/color-control-adapter.js";
import { positionToMatterPercent100ths, positionFromMatterPercent100ths } from "./clusters/window-covering-adapter.js";
import {
  celsiusToMatter,
  confirmedHeatCoolDirection,
  systemModeFromSupremeMode,
  temperatureCommandForSetpoint,
  temperatureCommandForSystemMode,
} from "./clusters/thermostat-control-adapter.js";

/**
 * The real `@matter/main` implementation of {@link MatterBridgeServer} (§3, §26 — no manual
 * packet encoding, no parallel Matter stack: this file is the ONLY place that touches
 * `@matter/main` for the Bridge). This is the ONE file in Phase 1 that cannot be exercised in
 * this sandbox: opening real UDP/mDNS sockets and a real PASE/CASE commissioning handshake
 * needs a real LAN and a real controller (Apple/Google/Alexa/a reference controller) — see
 * §29. Everything above this file (`MatterBridgeDriver`, `MatterEndpointRegistry`) is
 * transport-agnostic and IS unit-tested, against a fake `MatterBridgeServer`.
 *
 * § Matter Bridge Phase 1 foundation — this file is the "Cluster Adapters → Matter Endpoint"
 * end of the architecture: `device-types/matter-device-type-resolver.ts` decides WHICH Matter
 * Device Type a SupremeOS device becomes, and this file is where that resolved device type
 * actually gets composed from real `@matter/main` device definitions + cluster behaviors, using
 * the pure conversion functions in `clusters/*-adapter.ts` for every value that crosses the
 * SupremeOS↔Matter boundary. Five device types are wired: On/Off Light, Dimmable Light, Color
 * Temperature Light, Extended Color Light, Window Covering (§ Phase 1's supported set,
 * `device-types/matter-device-types.ts`).
 *
 * STATUS: verified against `@matter/main@0.17.9`'s real, installed TypeScript types
 * (`pnpm typecheck`) — this is real, but bounded, verification: it proves the API is called
 * the way this SDK version declares it, not that a real ecosystem accepts the result.
 * NOT VERIFIED — REQUIRES REAL HARDWARE / ECOSYSTEM: commissioning into Apple Home / Google
 * Home / Alexa / SmartThings, and operation over a real LAN.
 */

/**
 * § live-confirmed fix — every Color Temperature / Extended Color Light endpoint construction
 * failed with "Behaviors have errors" (root cause traced via a local reproduction against the
 * real @matter/main runtime, not guessed): `colorTemperatureMireds` is CONSTRAINED at validation
 * time against `colorTempPhysicalMinMireds`/`colorTempPhysicalMaxMireds` — two MANDATORY
 * ColorTemperature-feature attributes this code never set, so they defaulted to an unset/zero
 * bound that rejected literally any value, including the 3000K default. Matches SupremeOS's own
 * `ColorState.kelvin` schema bounds (1000K-10000K, `packages/domain-model/src/capabilities.ts`)
 * converted to mireds — never a per-device guess, always wide enough for any kelvin value
 * SupremeOS itself can ever send. Confirmed the exact failure via `services/protocols/
 * repro-cct.mjs` (a real ServerNode + real Endpoint construction, not a mock): ConstraintError
 * "Value 333 is not within bounds defined by constraint (135)" — 333 mireds (3000K) with no
 * declared physical range at all.
 */
const COLOR_TEMP_PHYSICAL_MIN_MIREDS = kelvinToMireds(10_000);
const COLOR_TEMP_PHYSICAL_MAX_MIREDS = kelvinToMireds(1_000);

const ON_OFF_LIGHT = 0x0100;
const ON_OFF_PLUG_IN_UNIT = 0x010a;
const DIMMABLE_LIGHT = 0x0101;
const COLOR_TEMPERATURE_LIGHT = 0x010c;
const EXTENDED_COLOR_LIGHT = 0x010d;
const WINDOW_COVERING = 0x0202;
const GENERIC_SWITCH = 0x000f;
const THERMOSTAT = 0x0301;

/** § Matter Bridge Phase 2B — SupremeOS's Universal Input Engine has ALREADY classified the
 * press (short/long/double/triple, with its own timing state machine — see
 * `packages/domain-model/src/keypad-events.ts`'s doc) by the time this reaches the Bridge. These
 * two knobs are shrunk from the SDK's real-world defaults (2s / 300ms) purely so a Matter report
 * doesn't sit behind an ARTIFICIAL wait that has nothing to do with the real button press —
 * SupremeOS's own timing decision already happened; a Matter subscriber should see it promptly
 * (§ Phase 1.3's "near-immediate local state propagation" principle applies here too). Small
 * enough that `reportKeypadPress`'s own driving delays (below) stay well clear of either
 * threshold in both directions, never a source of ambiguity between press types. */
const SWITCH_LONG_PRESS_DELAY_MS = 40;
const SWITCH_MULTI_PRESS_DELAY_MS = 60;
/** How long `reportKeypadPress` holds `currentPosition` at "pressed" before releasing, for a
 * press type that must resolve as SHORT relative to `SWITCH_LONG_PRESS_DELAY_MS` above. */
const SWITCH_SHORT_HOLD_MS = 5;
/** How long `reportKeypadPress` holds `currentPosition` at "pressed" for a press type that must
 * resolve as LONG — deliberately > `SWITCH_LONG_PRESS_DELAY_MS`. */
const SWITCH_LONG_HOLD_MS = 60;
/** Gap between the two/three taps of a multi-press sequence — deliberately « `SWITCH_MULTI_
 * PRESS_DELAY_MS` so the SDK's own multi-press window is still open for the next tap. */
const SWITCH_MULTI_PRESS_GAP_MS = 10;

type Emit = (endpointNumber: number, command: CapabilityCommand) => void;

/** OnOff behavior that ROUTES a genuine Matter On/Off command into a SupremeOS capability
 * command — used for On/Off Light (`onoff` capability) and Dimmable Light (`brightness`
 * capability, whose command schema also has an `action: "on"|"off"`). `this.endpoint.number`
 * is the same stable endpoint number the {@link MatterEndpointRegistry} assigned when the
 * endpoint was added, closing the loop between the persisted mapping and the live Matter node.
 * `super.on()/off()` still runs — it only updates the local OnOff attribute, real and desired,
 * never fake movement (unlike LevelControl/ColorControl's default transition simulation, which
 * the Level/Color adapter classes below deliberately do NOT invoke). */
function createRoutedOnOffServerClass(emit: Emit, buildCommand: (on: boolean) => CapabilityCommand) {
  return class BridgedOnOffServer extends OnOffServer {
    override async on() {
      await super.on();
      const n = this.endpoint.number;
      if (n !== undefined) emit(n, buildCommand(true));
    }
    override async off() {
      await super.off();
      const n = this.endpoint.number;
      if (n !== undefined) emit(n, buildCommand(false));
    }
  };
}

/** § Phase 1 disclosed limitation, narrowed in Phase 1.2 — Color Temperature/Extended Color
 * Light. SupremeOS's `color` capability command has NO bare on/off action — only hue/saturation/
 * kelvin/level. Every real CCT/RGB device this codebase bridges (KNX, Casambi) ALSO declares a
 * separate `brightness` (or `onoff`) capability alongside `color` (§ `capabilityKinds` on the
 * endpoint spec, populated from the device's real declared capabilities) — `createOnOffTargetFor`
 * below resolves the correct one and routes through it, exactly mirroring
 * `apps/web-homeowner/src/lighting.tsx`'s own `showBrightness ? "brightness" : "onoff"` toggle
 * fallback. This LOCAL-ONLY stub now only fires for the genuinely unresolvable edge case — a
 * device declaring `color` alone, with neither `onoff` nor `brightness` — where SupremeOS's
 * schema has no way to express on/off at all; the Matter attribute still updates locally so a
 * controller's UI stays consistent, but nothing is routed. */
class LocalOnlyOnOffServer extends OnOffServer {}

/** § Matter Bridge Phase 1.2 — "the common OnOff failure" / "KNX brightness failure" root-cause
 * fix. Resolves which SupremeOS capability the OnOff/LevelControl clusters of a Color
 * Temperature/Extended Color Light endpoint should route through, from the device's ACTUAL
 * declared capability set — never a per-protocol special case. Preference order matches the
 * frontend's own working convention (`lighting.tsx`): `brightness` (carries level too, so it's
 * preferred whenever present) → `onoff` → neither (stays local-only, see
 * {@link LocalOnlyOnOffServer}'s doc). This is why KNX (`["onoff","brightness","color"]`) and
 * Casambi (`["brightness","color"]`) both resolve to the SAME target (`"brightness"`) despite
 * KNX declaring onoff separately and Casambi not declaring it at all — no protocol knowledge
 * required, only the capability set every driver already reports honestly. */
export function resolveOnOffTarget(capabilityKinds: string[]): "brightness" | "onoff" | null {
  if (capabilityKinds.includes("brightness")) return "brightness";
  if (capabilityKinds.includes("onoff")) return "onoff";
  return null;
}

/** LevelControl has no equivalent for `"onoff"` (that capability's command schema carries no
 * `level` field at all — `packages/domain-model/src/capabilities.ts`) — only `"brightness"`
 * qualifies; every other case keeps the prior, working `"color"` level-embedded fallback. */
export function resolveLevelTarget(capabilityKinds: string[]): "brightness" | null {
  return capabilityKinds.includes("brightness") ? "brightness" : null;
}

function createLevelControlServerClass(onLevel: (endpointNumber: number, matterLevel: number) => void) {
  return class BridgedLevelControlServer extends LevelControlServer {
    // Deliberately does NOT call super.moveToLevelLogic — the default implementation
    // simulates a fake transition and writes CurrentLevel itself (§11: never fake feedback).
    // Real state only ever reaches the Matter attribute via `setCapabilityState`, once
    // SupremeOS's own native driver reports the physical device actually changed.
    override moveToLevelLogic(level: number, _transitionTime: number | null, _withOnOff: boolean): void {
      const n = this.endpoint.number;
      if (n !== undefined) onLevel(n, level);
    }
  };
}

/** Color Temperature Light's ColorControl (§ Matter Bridge Phase 1 foundation) — extends the
 * DEVICE TYPE's OWN generated, feature-selected base (`ColorTemperatureLightRequirements.
 * ColorControlServer`, `@matter/node`'s `color-temperature-light.ts`: `.with("ColorTemperature")`
 * — CT-only, no hue/saturation/xy) rather than reconstructing a feature set by hand, so this is
 * guaranteed to compose validly with `ColorTemperatureLightDevice.with(...)` below. */
function createColorTemperatureServerClass(onColorTemperature: (endpointNumber: number, mireds: number) => void) {
  return class BridgedColorTemperatureServer extends ColorTemperatureLightRequirements.ColorControlServer {
    override moveToColorTemperatureLogic(targetMireds: number, _transitionTime: number): void {
      const n = this.endpoint.number;
      if (n !== undefined) onColorTemperature(n, targetMireds);
    }
  };
}

/** Extended Color Light's ColorControl — extends `ExtendedColorLightRequirements.
 * ColorControlServer` (`.with("Xy", "ColorTemperature")` — this SDK's generated Extended Color
 * Light conforms via CIE xy chromaticity, not hue/saturation; see `clusters/
 * color-control-adapter.ts`'s doc comment for the xy↔hue/saturation conversion this requires). */
function createExtendedColorServerClass(
  onXy: (endpointNumber: number, matterX: number, matterY: number) => void,
  onColorTemperature: (endpointNumber: number, mireds: number) => void,
) {
  return class BridgedExtendedColorServer extends ExtendedColorLightRequirements.ColorControlServer {
    override moveToColorLogic(targetX: number, targetY: number, _transitionTime: number): void {
      const n = this.endpoint.number;
      if (n !== undefined) onXy(n, targetX, targetY);
    }
    override moveToColorTemperatureLogic(targetMireds: number, _transitionTime: number): void {
      const n = this.endpoint.number;
      if (n !== undefined) onColorTemperature(n, targetMireds);
    }
  };
}

function createWindowCoveringServerClass(onMovement: (endpointNumber: number, command: { action: "open" | "close" | "stop" | "set"; position?: number }) => void) {
  const Featured = WindowCoveringServer.with(WindowCovering.Feature.Lift, WindowCovering.Feature.PositionAwareLift);
  return class BridgedWindowCoveringServer extends Featured {
    // § Phase 1 — the SDK's own documented extension point ("Logic to actually move the
    // device... The default implementation logs and immediately updates current position to
    // the target positions. This is probably not desirable for a real device so do not invoke
    // super.handleMovement()" — @matter/node's own WindowCoveringServer.ts doc comment). Real
    // position only ever reaches the Matter attribute via `setCapabilityState`.
    //
    // § live-confirmed fix (Matter Bridge Phase 1.3 — "Apple Home 32% -> ~50%, 75% -> ~100%,
    // intermediate values not preserved"). Root cause traced against the REAL, installed
    // `@matter/node` source (`WindowCoveringServer.js`'s `#prepareMovement`, lines ~266-271):
    // whenever `direction === DefinedByPosition` AND the current lift position is already known
    // (non-null — true for every movement after the very first, since `addEndpoint` always seeds
    // a real initial position), the SDK ITSELF REWRITES `direction` to plain `Open`/`Close`
    // before calling this handler — `DefinedByPosition` essentially never survives to reach here
    // in practice, even for a slider-driven `GoToLiftPercentage` command. The OLD code only
    // extracted `targetPercent100ths` on the `DefinedByPosition` branch, so every slider drag
    // silently collapsed into a bare `{action:"open"}`/`{action:"close"}` — discarding the exact
    // percentage entirely, which is exactly what produced the reported quantization (32%/75%
    // both landing near whatever "fully open"/"fully closed" resolves to on the underlying
    // driver). The SDK still passes the REAL, un-mangled `targetPercent100ths` through
    // regardless of how it rewrote `direction` (confirmed in the same source — `#prepareMovement`
    // forwards its own `targetPercent100ths` parameter unchanged to `handleMovement`), so the fix
    // is to always prefer the precise target whenever one is present, and only fall back to a
    // bare open/close when the command genuinely carries no percentage (a physical up/down
    // button, or a plain `UpOrOpen`/`DownOrClose` command on a device with no position feature).
    override handleMovement(type: MovementType, _reversed: boolean, direction: MovementDirection, targetPercent100ths?: number): void {
      const n = this.endpoint.number;
      if (n === undefined || type !== MovementType.Lift) return;
      if (targetPercent100ths !== undefined) {
        onMovement(n, { action: "set", position: positionFromMatterPercent100ths(targetPercent100ths) });
      } else if (direction === MovementDirection.Open) {
        onMovement(n, { action: "open" });
      } else if (direction === MovementDirection.Close) {
        onMovement(n, { action: "close" });
      }
    }
    override handleStopMovement(): void {
      const n = this.endpoint.number;
      if (n !== undefined) onMovement(n, { action: "stop" });
    }
  };
}

/**
 * § Matter Bridge Phase 3.2 — CoolMaster Thermostat command routing. Per the approved Phase
 * 3.1.1 decision record §6/§9: `Thermostat.with("Heating","Cooling")`'s own real, unforked SDK
 * behavior (`ThermostatServer`) is what performs Matter-side constraint validation on every
 * write (rejecting an absurd value like 9999 before it ever reaches this code, using the SDK's
 * generic 700-3000/1600-3200 default envelope — NOT a claim about CoolMaster's real hardware
 * range, which does not exist anywhere in this driver — see that record's §3/§4/§8). This class
 * never overrides that validation and never forks/rewrites `ThermostatServer` — it only adds
 * its OWN additional reactors (`reactTo`, the same wiring mechanism `ThermostatServer`'s own
 * internal `#handleSystemModeChange` uses) that fire AFTER a write has already passed the SDK's
 * validation, and simply forward the now-validated value onward as a SupremeOS capability
 * command — the identical "SDK validates/passes through, SupremeOS/the physical device is the
 * real authority" shape as every other routed cluster in this file.
 *
 * `setCapabilityState`'s own confirmed-state writes (below) also flow through `ep.set()`, which
 * fires these SAME reactors — an accepted, explicitly-documented tradeoff (Phase 3.1.1 §6): the
 * confirmed value gets re-sent to SupremeOS/CoolMaster as a redundant, idempotent command
 * ("set target temp to the temp it's already at" / "set mode to the mode it's already in"),
 * which CoolMaster's own command queue already coalesces via its existing dedupe-by-key
 * mechanism and which produces no observable effect on the physical unit — never an infinite
 * loop, since the redundant command cannot itself change the confirmed state again.
 */
function createRoutedThermostatServerClass(
  onSystemMode: (endpointNumber: number, command: CapabilityCommand) => void,
  onSetpoint: (endpointNumber: number, command: CapabilityCommand) => void,
) {
  const Featured = ThermostatRequirements.server.mandatory.Thermostat.with("Heating", "Cooling");
  return class BridgedThermostatServer extends Featured {
    override initialize() {
      super.initialize();
      this.reactTo(this.events.systemMode$Changed, (mode: Thermostat.SystemMode) => {
        const n = this.endpoint.number;
        if (n === undefined) return;
        const command = temperatureCommandForSystemMode(mode);
        // § Phase 3.1.1 §9 mode mapping — `null` means "auto" or another value this endpoint's
        // feature set can't legally hold reached here anyway (defensive; the SDK's own
        // conformance validation already rejects `SystemMode.Auto` before this fires — see the
        // Phase 3.1.1 reproduction). Never forward a fabricated mode.
        if (command) onSystemMode(n, command);
      });
      this.reactTo(this.events.occupiedHeatingSetpoint$Changed, (value: number) => {
        const n = this.endpoint.number;
        if (n !== undefined) onSetpoint(n, temperatureCommandForSetpoint(value));
      });
      this.reactTo(this.events.occupiedCoolingSetpoint$Changed, (value: number) => {
        const n = this.endpoint.number;
        if (n !== undefined) onSetpoint(n, temperatureCommandForSetpoint(value));
      });
    }
  };
}

export interface RealMatterBridgeServerOptions {
  /**
   * Directory `@matter/main` persists ALL Matter runtime state under, keyed internally by
   * `nodeId` — the storage boundary (§ Phase 2, Persistence):
   *
   *   SupremeOS-owned:  MatterEndpointRegistry's JSON file (deviceId <-> endpoint number)
   *   @matter/main-owned: node identity, fabric/commissioning state, operational
   *     credentials/certificates, and per-endpoint attribute state (incl. the OnOff value
   *     `setCapabilityState` writes) — everything else under this directory.
   *
   * SupremeOS never re-implements or reaches into @matter/main's own files — it only ever
   * calls the SDK's own API (`ServerNode`/`Endpoint`). The ONE thing SupremeOS must get right
   * is making this directory itself durable: it MUST be a real persistent volume/mount, never
   * a container's writable layer or a driver-install/staging directory that a normal
   * upgrade/rollback/reinstall can wipe (`infra/hub-compose/docker-compose.yml`'s
   * `supreme-matter` volume and `infra/native-linux/install.sh`'s `$SUPREME_DATA_DIR/matter`
   * are the two production instances of this). Backup/restore must copy this directory
   * verbatim alongside the endpoint-registry file — neither is meaningful without the other
   * (a registry entry with no matching Matter node is an orphaned mapping; a Matter node with
   * no registry entry can't be routed to a SupremeOS device).
   *
   * The Bridge and the pre-existing Matter CONTROLLER (`matter-driver.ts`) are separate
   * `ServerNode`/controller identities and MUST use separate storage directories — never the
   * same path. Callers should pass a Bridge-specific subdirectory (e.g.
   * `${SUPREME_MATTER_STORAGE_PATH}/bridge`), not the shared root.
   */
  storagePath: string;
  /** Unique, STABLE node id — part of the storage key and the discoverable device's
   * identity. Changing this across restarts would orphan the persisted fabric. */
  nodeId: string;
  vendorId?: number;
  productId?: number;
  productName?: string;
  vendorName?: string;
}

interface BridgedEndpointEntry {
  endpoint: Endpoint;
  deviceTypeId: number;
}

export class RealMatterBridgeServer implements MatterBridgeServer {
  private node: ServerNode | undefined;
  private aggregator: Endpoint | undefined;
  private readonly endpoints = new Map<number, BridgedEndpointEntry>();
  private readonly commandListeners = new Set<Emit>();

  constructor(private readonly opts: RealMatterBridgeServerOptions) {}

  async start(): Promise<void> {
    if (this.node) return;
    // § Phase 5 §10 — security fix, not a workaround: @matter/node's CommissioningServer logs
    // the passcode/discriminator/manual pairing code/QR text at NOTICE level on every boot
    // while uncommissioned (`initiateCommissioning()`, verified against its real source — see
    // Phase 4's commit). Left at its default, that line lands in `journalctl -u
    // supreme-gateway` unredacted. This uses the SDK's own PUBLIC, documented facility-level
    // API (`Logger.facilityLevels`, `@matter/general/src/log/Logger.ts`) to raise the
    // "Commissioning" facility's floor to WARN — no fork, no monkey-patch, no reach into an
    // unexported internal. Real commissioning ERRORS/WARNs (a genuinely failed pairing
    // attempt) still print; only the routine, credential-bearing NOTICE line is suppressed.
    // `getCommissioningState()` remains the intended, controlled way to retrieve the pairing
    // code — gated at the API layer once a route exists (§ Phase 4's security review).
    Logger.facilityLevels = { Commissioning: LogLevel.WARN };

    // § live-confirmed fix — a FRESH `Environment` per server, never the process-wide
    // `Environment.default` singleton — see git history for the full root-cause writeup
    // (Environment.default's services are created once and cached on that one instance;
    // sharing it across RealMatterBridgeServer instances leaked storage/endpoint state).
    const environment = new Environment(this.opts.nodeId, Environment.default);
    environment.vars.set("storage.path", this.opts.storagePath);

    this.node = await ServerNode.create({
      id: this.opts.nodeId,
      environment,
      productDescription: {
        name: this.opts.productName ?? "SupremeOS Matter Bridge",
        deviceType: AggregatorEndpoint.deviceType,
      },
      basicInformation: {
        vendorId: VendorId(this.opts.vendorId ?? 0xfff1),
        vendorName: this.opts.vendorName ?? "Supreme Domotics",
        productId: this.opts.productId ?? 0x8000,
        productName: this.opts.productName ?? "SupremeOS Matter Bridge",
        nodeLabel: "SupremeOS",
      },
    });

    // § real root cause of "Endpoint device-1 number 1 is allocated to another endpoint" —
    // the aggregator auto-allocates the SDK's first free number (1) unless given an explicit,
    // reserved one outside the 1-based device-number range `addEndpoint` uses.
    this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator", number: 0xfffe });
    await this.node.add(this.aggregator);
    await this.node.start();
  }

  async stop(): Promise<void> {
    await this.node?.close();
    this.node = undefined;
    this.aggregator = undefined;
    this.endpoints.clear();
  }

  /**
   * § Matter Bridge Phase 1 foundation — composes the real `@matter/main` device definition +
   * cluster behaviors for whichever Matter Device Type `spec.deviceTypeId` names, using the
   * pure conversion functions in `clusters/*-adapter.ts` for every attribute value. This is the
   * one place in the codebase that switches on a Matter Device Type id to build SDK objects —
   * that is inherent to the SDK-integration boundary (a finite, spec-driven mapping), NOT the
   * "infer device type from capability presence" anti-pattern this Phase exists to remove: the
   * device type here is already RESOLVED (by `matter-device-type-resolver.ts`, upstream of this
   * call) — this method never re-derives or second-guesses it from `spec.initialState`.
   */
  async addEndpoint(spec: MatterBridgeEndpointSpec): Promise<void> {
    if (!this.aggregator) throw new Error("matter-bridge: server not started");
    if (this.endpoints.has(spec.endpointNumber)) return; // idempotent (§ Endpoint architecture)

    const emit: Emit = (endpointNumber, command) => {
      for (const l of this.commandListeners) l(endpointNumber, command);
    };
    const baseOptions = {
      id: `device-${spec.endpointNumber}`,
      number: spec.endpointNumber,
      bridgedDeviceBasicInformation: { nodeLabel: spec.name, reachable: true },
    };

    let endpoint: Endpoint;
    switch (spec.deviceTypeId) {
      case ON_OFF_LIGHT: {
        const initial = spec.initialState?.kind === "onoff" ? spec.initialState : null;
        const OnOffServerClass = createRoutedOnOffServerClass(emit, (on) => ({ capability: "onoff", action: on ? "on" : "off" }));
        endpoint = new Endpoint(OnOffLightDevice.with(BridgedDeviceBasicInformationServer, OnOffServerClass), {
          ...baseOptions,
          onOff: { onOff: initial?.on ?? false },
        });
        break;
      }
      // § Matter Bridge Phase 2A — On/Off Plug-in Unit. Structurally identical cluster
      // composition to ON_OFF_LIGHT (same required clusters, same routing) — the ONLY
      // difference is `OnOffPlugInUnitDevice` vs `OnOffLightDevice`, which is what tells Apple/
      // Google/Alexa/SmartThings to render this as a switched outlet, not a light. Never a
      // second code path — this is a straight copy of the ON_OFF_LIGHT branch below with the
      // device definition swapped, deliberately, so the two branches drift in lockstep if the
      // shared On/Off routing logic ever changes.
      case ON_OFF_PLUG_IN_UNIT: {
        const initial = spec.initialState?.kind === "onoff" ? spec.initialState : null;
        const OnOffServerClass = createRoutedOnOffServerClass(emit, (on) => ({ capability: "onoff", action: on ? "on" : "off" }));
        endpoint = new Endpoint(OnOffPlugInUnitDevice.with(BridgedDeviceBasicInformationServer, OnOffServerClass), {
          ...baseOptions,
          onOff: { onOff: initial?.on ?? false },
        });
        break;
      }
      case DIMMABLE_LIGHT: {
        const initial = spec.initialState?.kind === "brightness" ? spec.initialState : null;
        const OnOffServerClass = createRoutedOnOffServerClass(emit, (on) => ({ capability: "brightness", action: on ? "on" : "off" }));
        const LevelServerClass = createLevelControlServerClass((n, matterLevel) =>
          emit(n, { capability: "brightness", action: "set", level: levelFromMatter(matterLevel) }),
        );
        endpoint = new Endpoint(DimmableLightDevice.with(BridgedDeviceBasicInformationServer, OnOffServerClass, LevelServerClass), {
          ...baseOptions,
          onOff: { onOff: initial?.on ?? false },
          levelControl: { currentLevel: levelToMatter(initial?.level ?? 0) },
        });
        break;
      }
      case COLOR_TEMPERATURE_LIGHT: {
        const initial = spec.initialState?.kind === "color" ? spec.initialState : null;
        const onOffTarget = resolveOnOffTarget(spec.capabilityKinds ?? []);
        const levelTarget = resolveLevelTarget(spec.capabilityKinds ?? []);
        const LevelServerClass = createLevelControlServerClass((n, matterLevel) => {
          const level = levelFromMatter(matterLevel);
          emit(n, levelTarget ? { capability: levelTarget, action: "set", level } : { capability: "color", level });
        });
        const ColorServerClass = createColorTemperatureServerClass((n, mireds) => emit(n, { capability: "color", kelvin: miredsToKelvin(mireds) }));
        const OnOffServerClass = onOffTarget
          ? createRoutedOnOffServerClass(emit, (on) => ({ capability: onOffTarget, action: on ? "on" : "off" }))
          : LocalOnlyOnOffServer;
        endpoint = new Endpoint(ColorTemperatureLightDevice.with(BridgedDeviceBasicInformationServer, OnOffServerClass, LevelServerClass, ColorServerClass), {
          ...baseOptions,
          onOff: { onOff: initial?.on ?? false },
          levelControl: { currentLevel: levelToMatter(initial?.level ?? 0) },
          colorControl: {
            colorTempPhysicalMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            colorTempPhysicalMaxMireds: COLOR_TEMP_PHYSICAL_MAX_MIREDS,
            coupleColorTempToLevelMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            colorTemperatureMireds: kelvinToMireds(initial?.kelvin ?? 3000),
            colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
          },
        });
        break;
      }
      case EXTENDED_COLOR_LIGHT: {
        const initial = spec.initialState?.kind === "color" ? spec.initialState : null;
        const onOffTarget = resolveOnOffTarget(spec.capabilityKinds ?? []);
        const levelTarget = resolveLevelTarget(spec.capabilityKinds ?? []);
        const LevelServerClass = createLevelControlServerClass((n, matterLevel) => {
          const level = levelFromMatter(matterLevel);
          emit(n, levelTarget ? { capability: levelTarget, action: "set", level } : { capability: "color", level });
        });
        const ColorServerClass = createExtendedColorServerClass(
          (n, matterX, matterY) => {
            const { hue, saturation } = xyToHueSaturation(xyChannelFromMatter(matterX), xyChannelFromMatter(matterY));
            emit(n, { capability: "color", hue, saturation });
          },
          (n, mireds) => emit(n, { capability: "color", kelvin: miredsToKelvin(mireds) }),
        );
        const OnOffServerClass = onOffTarget
          ? createRoutedOnOffServerClass(emit, (on) => ({ capability: onOffTarget, action: on ? "on" : "off" }))
          : LocalOnlyOnOffServer;
        const usesKelvin = initial?.kelvin != null;
        const xy = usesKelvin ? { x: 0, y: 0 } : hueSaturationToXy(initial?.hue ?? 0, initial?.saturation ?? 0);
        endpoint = new Endpoint(ExtendedColorLightDevice.with(BridgedDeviceBasicInformationServer, OnOffServerClass, LevelServerClass, ColorServerClass), {
          ...baseOptions,
          onOff: { onOff: initial?.on ?? false },
          levelControl: { currentLevel: levelToMatter(initial?.level ?? 0) },
          colorControl: {
            colorTempPhysicalMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            colorTempPhysicalMaxMireds: COLOR_TEMP_PHYSICAL_MAX_MIREDS,
            coupleColorTempToLevelMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            currentX: xyChannelToMatter(xy.x),
            currentY: xyChannelToMatter(xy.y),
            colorTemperatureMireds: kelvinToMireds(initial?.kelvin ?? 3000),
            colorMode: usesKelvin ? ColorControl.ColorMode.ColorTemperatureMireds : ColorControl.ColorMode.CurrentXAndCurrentY,
          },
        });
        break;
      }
      case WINDOW_COVERING: {
        const initial = spec.initialState?.kind === "position" ? spec.initialState : null;
        const percent100ths = positionToMatterPercent100ths(initial?.position ?? 100);
        const CoveringServerClass = createWindowCoveringServerClass((n, command) => emit(n, { capability: "position", ...command }));
        endpoint = new Endpoint(WindowCoveringDevice.with(BridgedDeviceBasicInformationServer, CoveringServerClass), {
          ...baseOptions,
          windowCovering: {
            currentPositionLiftPercent100ths: percent100ths,
            targetPositionLiftPercent100ths: percent100ths,
          },
        });
        break;
      }
      // § Matter Bridge Phase 2B — Generic Switch (one physical button = one endpoint, per the
      // architecture decision in `matter-device-types.ts`'s doc). Momentary-switch features only
      // (Release/LongPress/MultiPress) — no LatchingSwitch (a physical button isn't latching) and
      // no ActionSwitch (we don't suppress the ongoing multi-press reports). No `emit`/command
      // routing at all: unlike every other device type here, a Generic Switch is UNIDIRECTIONAL
      // (SupremeOS → Matter only) — a real Matter controller has no "command" to send a switch,
      // only subscribes to its events, confirmed against the SDK's own generated device
      // definition (`generic-switch.js`: no client-writable attributes, no commands).
      case GENERIC_SWITCH: {
        const SwitchServerClass = SwitchServer.with(
          Switch.Feature.MomentarySwitch,
          Switch.Feature.MomentarySwitchRelease,
          Switch.Feature.MomentarySwitchLongPress,
          Switch.Feature.MomentarySwitchMultiPress,
        );
        endpoint = new Endpoint(GenericSwitchDevice.with(BridgedDeviceBasicInformationServer, SwitchServerClass), {
          ...baseOptions,
          switch: {
            currentPosition: 0,
            numberOfPositions: 2,
            // § `longPressDelay`/`multiPressDelay` are the SDK's own `Duration`-branded type
            // (`@matter/general`'s `Millis()`) — a plain number is functionally identical at
            // runtime (Duration is a nominal number brand, not a distinct runtime type) but
            // fails the structural type check; casting through the SAME behavior's own generic
            // `set()` signature (used identically by every other cluster write in this file) is
            // simpler than importing `Millis` from a transitive dependency this package doesn't
            // declare directly.
            longPressDelay: SWITCH_LONG_PRESS_DELAY_MS,
            multiPressDelay: SWITCH_MULTI_PRESS_DELAY_MS,
            multiPressMax: 3,
          } as unknown as Record<string, unknown>,
        });
        break;
      }
      // § Matter Bridge Phase 3.2 — CoolMaster Thermostat. `Identify` + `Thermostat.with(
      // "Heating","Cooling")` ONLY — no `AutoMode`/`Presets`/`MatterScheduleConfiguration`/
      // `Events`/`FanControl`/OnOff (see the approved Phase 3.1.1 decision record and
      // `matter-device-types.ts`'s doc comment for the full rationale). `thermostatRunningMode`
      // does not exist as an attribute at all under this feature set (confirmed by the real
      // SDK's own generated type — it's gated behind the `AutoMode` feature, deliberately never
      // enabled here per Phase 3.1.1 §9), so `ThermostatServer`'s internal `systemMode`->
      // `thermostatRunningMode` cascade simply never engages — correctly: there is no Matter-
      // side derived running-mode state to seed or to mistake for real CoolMaster physical
      // state (§ Phase 3.1.1 §11).
      case THERMOSTAT: {
        const initial = spec.initialState?.kind === "temperature" ? spec.initialState : null;
        const ThermostatServerClass = createRoutedThermostatServerClass(
          (n, command) => emit(n, command),
          (n, command) => emit(n, command),
        );
        // § Phase 3.4C — the SAME confirmedHeatCoolDirection() precedence used by the
        // runtime confirmed-state write path below (case "temperature" in
        // setCapabilityState-equivalent code), applied here too so a KNX-backed
        // Thermostat's INITIAL endpoint construction (e.g. after a gateway restart,
        // seeded from the last-persisted confirmed state) reflects heatCool exactly like
        // every subsequent update does — this construction-time seed is not a separate,
        // stale code path.
        const systemMode = initial
          ? (systemModeFromSupremeMode(confirmedHeatCoolDirection(initial)) ?? Thermostat.SystemMode.Off)
          : Thermostat.SystemMode.Off;
        const targetMatter = initial?.targetC != null ? celsiusToMatter(initial.targetC) : celsiusToMatter(21);
        endpoint = new Endpoint(ThermostatDevice.with(BridgedDeviceBasicInformationServer, ThermostatServerClass), {
          ...baseOptions,
          thermostat: {
            systemMode,
            localTemperature: celsiusToMatter(initial?.ambientC ?? 21),
            // § Phase 3.1.1 §10 — both setpoints seeded from the SAME single `targetC` (never
            // separate heating/cooling targets); which one is ever meaningfully ACTIVE is
            // determined by `systemMode`, not by which of these two attributes holds a value.
            occupiedHeatingSetpoint: targetMatter,
            occupiedCoolingSetpoint: targetMatter,
            controlSequenceOfOperation: Thermostat.ControlSequenceOfOperation.CoolingAndHeating,
          },
        });
        break;
      }
      default:
        throw new Error(`matter-bridge: unsupported Matter Device Type id 0x${spec.deviceTypeId.toString(16)}`);
    }

    await this.aggregator.add(endpoint);
    this.endpoints.set(spec.endpointNumber, { endpoint, deviceTypeId: spec.deviceTypeId });
  }

  async removeEndpoint(endpointNumber: number): Promise<void> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) return;
    await entry.endpoint.delete();
    this.endpoints.delete(endpointNumber);
  }

  /** § Matter Bridge Phase 1.2 — writes the BridgedDeviceBasicInformation cluster's `NodeLabel`
   * attribute, the same field EVERY device type's `addEndpoint` branch above already seeds at
   * construction time via `bridgedDeviceBasicInformation: { nodeLabel: ... }` — this is device-
   * type-agnostic by construction (every branch composes `BridgedDeviceBasicInformationServer`
   * identically), never a per-device-type special case. `NodeLabel` is a real, live-writable
   * Matter attribute (not commissioning-only metadata), so a subscribed controller — Apple
   * Home included — is expected to pick up the change without recommissioning; see this
   * method's callers for the disclosed caveat about a controller's own local display cache. */
  async updateEndpointName(endpointNumber: number, name: string): Promise<void> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) return;
    const ep = entry.endpoint as unknown as { set(values: Record<string, unknown>): Promise<void> };
    await ep.set({ bridgedDeviceBasicInformation: { nodeLabel: name } });
  }

  /** § Matter Bridge Phase 1.2 — read back an endpoint's REAL, live `NodeLabel` attribute
   * value directly off the `@matter/main` endpoint (not a SupremeOS-side copy) — exists so a
   * test can prove `updateEndpointName`/`addEndpoint` actually wrote what a real Matter
   * controller would read, not merely that the call didn't throw. Not part of the abstract
   * `MatterBridgeServer` interface (no test-only surface leaks into the seam other transports
   * implement) — a `RealMatterBridgeServer`-only diagnostic accessor. `null` if the endpoint
   * doesn't exist. */
  getEndpointNodeLabel(endpointNumber: number): string | null {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) return null;
    const ep = entry.endpoint as unknown as { state: { bridgedDeviceBasicInformation?: { nodeLabel?: string } } };
    return ep.state.bridgedDeviceBasicInformation?.nodeLabel ?? null;
  }

  /** § Matter Bridge Phase 1.2B — test-only diagnostic accessor, same rationale as
   * `getEndpointNodeLabel` above: invokes a REAL cluster command through the SDK's OWN command-
   * dispatch entry point (`Endpoint.act()` — the same mechanism `@matter/node`'s interaction/
   * command-processing layer uses for a genuine incoming Matter command from a real controller),
   * not a direct call to our override method. This is what makes a test using it a genuine proof
   * that "Apple Home sends OnOff.On" reaches our `emit()` callback — calling
   * `behaviorInstance.on()` directly would only prove the METHOD exists, not that the SDK's own
   * dispatch machinery resolves to it. Not part of the abstract `MatterBridgeServer` interface. */
  async simulateCommandForTest<T>(endpointNumber: number, actor: (agent: { [key: string]: any }) => T | Promise<T>): Promise<T> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) throw new Error(`matter-bridge: no endpoint ${endpointNumber} to simulate a command against`);
    return entry.endpoint.act((agent) => actor(agent as unknown as { [key: string]: any }));
  }

  /** § Matter Bridge Phase 3.2 — test-only diagnostic accessor for clusters (Thermostat) whose
   * controller-facing writes are plain ATTRIBUTE writes, not invokable commands (there is no
   * `agent.thermostat.someCommand()` for "set systemMode" the way there is `agent.onOff.on()`)
   * — so `simulateCommandForTest`'s `Endpoint.act()` entry point doesn't apply. This calls the
   * SAME real `Endpoint.set()` path a genuine Matter controller's attribute-write interaction
   * uses (confirmed live in the Phase 3.1.1 reproduction — real conformance/constraint
   * validation runs on every `set()` call, exactly as it would for a real controller), so a test
   * using it proves the SDK's own validation and this file's `reactTo` wiring both fire for
   * real, not merely that our own method exists. Not part of the abstract `MatterBridgeServer`
   * interface. */
  async simulateAttributeWriteForTest(endpointNumber: number, values: Record<string, unknown>): Promise<void> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) throw new Error(`matter-bridge: no endpoint ${endpointNumber} to simulate an attribute write against`);
    const ep = entry.endpoint as unknown as { set(values: Record<string, unknown>): Promise<void> };
    await ep.set(values);
  }

  /** § Matter Bridge Phase 3.2 — test-only diagnostic accessor, same rationale as
   * `getEndpointNodeLabel`: reads the endpoint's REAL, live `thermostat` cluster state directly
   * off the `@matter/main` endpoint, not a SupremeOS-side copy. `null` if the endpoint doesn't
   * exist or isn't a Thermostat. */
  getThermostatStateForTest(endpointNumber: number): Record<string, unknown> | null {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry || entry.deviceTypeId !== THERMOSTAT) return null;
    const ep = entry.endpoint as unknown as { state: { thermostat?: Record<string, unknown> } };
    return ep.state.thermostat ?? null;
  }

  /** § Matter Bridge Phase 2B — test-only diagnostic accessor, same rationale as
   * `simulateCommandForTest`: subscribes directly to the REAL Switch cluster's own event
   * observables (`endpoint.events.switch.*`) so a test can prove `reportKeypadPress` produces
   * the exact `initialPress`/`shortRelease`/`longPress`/`longRelease`/`multiPressComplete`
   * sequence the real SDK's spec-compliant `SwitchServer` derives — not a call to our own code
   * asserting itself. Not part of the abstract `MatterBridgeServer` interface. */
  collectSwitchEventsForTest(endpointNumber: number): { events: { type: string; payload: unknown }[] } {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) throw new Error(`matter-bridge: no endpoint ${endpointNumber} to observe switch events on`);
    const events: { type: string; payload: unknown }[] = [];
    const switchEvents = (entry.endpoint as unknown as { events: { switch: Record<string, { on(cb: (payload: unknown) => void): unknown }> } })
      .events.switch;
    for (const type of ["initialPress", "shortRelease", "longPress", "longRelease", "multiPressComplete"]) {
      switchEvents[type]?.on((payload: unknown) => events.push({ type, payload }));
    }
    return { events };
  }

  /** A direct attribute write — this is a STATE REPORT, not a command invocation, so it does
   * NOT re-enter any of the Bridged*Server command handlers above (§11 loop-safety). Dispatches
   * on `state.kind`, not on the endpoint's device type — a state kind that doesn't match
   * anything this endpoint's composed clusters expose is simply ignored (§ Phase 1: a defensive
   * no-op, never a crash — `handleSupremeStateChange` in `matter-bridge-driver.ts` already only
   * forwards the endpoint's own `primaryCapability`, so this is a second, cheap safety net). */
  async setCapabilityState(endpointNumber: number, state: CapabilityState): Promise<void> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry) return;
    // § Matter Bridge Phase 1 foundation — `Endpoint.set()`'s parameter type is generic over
    // the SPECIFIC composed behavior set that particular endpoint instance was constructed
    // with (`addEndpoint`'s `switch`, five different compositions) — a value this method
    // genuinely doesn't know statically, since a single `Map<number, BridgedEndpointEntry>`
    // holds every device type's endpoints uniformly (the whole point of this being one
    // generic method instead of five device-type-specific ones). Each branch below only ever
    // sets keys that belong to the clusters ITS OWN device type actually composed in
    // `addEndpoint` — verified by the `state.kind`/`deviceTypeId` guards, not by this cast.
    const ep = entry.endpoint as unknown as { set(values: Record<string, unknown>): Promise<void> };
    switch (state.kind) {
      case "onoff":
        await ep.set({ onOff: { onOff: state.on } });
        return;
      case "brightness":
        await ep.set({ onOff: { onOff: state.on }, levelControl: { currentLevel: levelToMatter(state.level) } });
        return;
      case "color": {
        const colorControl: Record<string, unknown> = {};
        if (state.kelvin !== null) {
          colorControl.colorTemperatureMireds = kelvinToMireds(state.kelvin);
          colorControl.colorMode = ColorControl.ColorMode.ColorTemperatureMireds;
        } else if (entry.deviceTypeId === EXTENDED_COLOR_LIGHT && state.hue !== null && state.saturation !== null) {
          const xy = hueSaturationToXy(state.hue, state.saturation);
          colorControl.currentX = xyChannelToMatter(xy.x);
          colorControl.currentY = xyChannelToMatter(xy.y);
          colorControl.colorMode = ColorControl.ColorMode.CurrentXAndCurrentY;
        }
        await ep.set({
          onOff: { onOff: state.on },
          levelControl: { currentLevel: levelToMatter(state.level) },
          colorControl,
        });
        return;
      }
      case "position": {
        const percent100ths = positionToMatterPercent100ths(state.position);
        await ep.set({
          windowCovering: { currentPositionLiftPercent100ths: percent100ths, targetPositionLiftPercent100ths: percent100ths },
        });
        return;
      }
      // § Matter Bridge Phase 3.2 — CoolMaster Thermostat confirmed-state report. This is the
      // SOLE path that reports what CoolMaster's physical unit actually confirmed — a Matter
      // controller's write is NEVER treated as physical truth on its own (Phase 3.1.1 §6/§9);
      // only a real `onState` event (this method's caller) reaches here.
      //
      // § Production fix — a `temperature` capability event can arrive for a device whose
      // endpoint was bridged as a non-Thermostat device type (e.g. a CoolMaster unit exposed
      // as an On/Off Light because its declared capability set didn't route it to THERMOSTAT
      // at `addEndpoint` time) — that endpoint's composed clusters have no `thermostat`
      // Behavior at all, so `ep.set({ thermostat })` below throws matter.js's
      // `endpoint-behavior-not-present` as a genuinely FATAL, process-crashing unhandled
      // rejection (confirmed in production: crash-looped the whole gateway every ~2 minutes,
      // in lockstep with CoolMaster's poll cycle). This method's own doc comment above already
      // promises "a state kind that doesn't match anything this endpoint's composed clusters
      // expose is simply ignored... never a crash" — the `color` case already honors that by
      // checking `entry.deviceTypeId` before touching color-specific fields; `temperature` must
      // too, since `thermostat` is ONLY composed for THERMOSTAT-typed endpoints.
      case "temperature": {
        if (entry.deviceTypeId !== THERMOSTAT) return;
        const thermostat: Record<string, unknown> = { localTemperature: celsiusToMatter(state.ambientC) };
        // § Phase 3.4C — `heatCool` (a dedicated, confirmed heat/cool selector — e.g. KNX
        // DPT 1.100) takes priority over the generic `mode` field when it holds a real
        // value; falls through to `mode` unchanged when `heatCool` is absent (CoolMaster
        // never sets it, so this is a pure no-op there — see confirmedHeatCoolDirection's
        // own doc comment for the full reasoning).
        const confirmedDirection = confirmedHeatCoolDirection(state);
        const systemMode = systemModeFromSupremeMode(confirmedDirection);
        // `null` = "auto" — deliberately DO NOT write `systemMode` at all (Phase 3.1.1's
        // documented, explicit degradation: leave the attribute at its last-reported value
        // rather than fabricate which single Matter mode "auto" should look like).
        if (systemMode !== null) thermostat.systemMode = systemMode;
        if (state.targetC != null) {
          const matterSetpoint = celsiusToMatter(state.targetC);
          // § Phase 3.1.1 §9/§10 — only the setpoint matching the CONFIRMED direction is
          // meaningful; `fan_only`/`off`/`auto` have no active target, so neither setpoint
          // is touched (never invents a value for a setpoint that isn't the one actually
          // driving the unit). Uses the SAME confirmedDirection as systemMode above (§
          // Phase 3.4C) so the two attributes can never disagree about which setpoint is live.
          if (confirmedDirection === "heat") thermostat.occupiedHeatingSetpoint = matterSetpoint;
          else if (confirmedDirection === "cool") thermostat.occupiedCoolingSetpoint = matterSetpoint;
        }
        await ep.set({ thermostat });
        return;
      }
      default:
        return;
    }
  }

  /** § Matter Bridge Phase 2B — see the `MatterBridgeServer` interface doc for the full
   * rationale. Drives REAL `currentPosition` transitions through `endpoint.set()`; the real,
   * spec-compliant `SwitchServer` behavior composed in `addEndpoint`'s `GENERIC_SWITCH` case
   * derives the correct event sequence from them (verified live against this SDK — see the
   * command-dispatch test suite). Never touches any endpoint that isn't a Generic Switch. */
  async reportKeypadPress(endpointNumber: number, press: "short" | "long" | "double" | "triple"): Promise<void> {
    const entry = this.endpoints.get(endpointNumber);
    if (!entry || entry.deviceTypeId !== GENERIC_SWITCH) return;
    const ep = entry.endpoint as unknown as { set(values: Record<string, unknown>): Promise<void> };
    const tap = async (holdMs: number) => {
      await ep.set({ switch: { currentPosition: 1 } });
      await new Promise((r) => setTimeout(r, holdMs));
      await ep.set({ switch: { currentPosition: 0 } });
    };
    switch (press) {
      case "short":
        await tap(SWITCH_SHORT_HOLD_MS);
        return;
      case "long":
        await tap(SWITCH_LONG_HOLD_MS);
        return;
      case "double":
        await tap(SWITCH_SHORT_HOLD_MS);
        await new Promise((r) => setTimeout(r, SWITCH_MULTI_PRESS_GAP_MS));
        await tap(SWITCH_SHORT_HOLD_MS);
        return;
      case "triple":
        await tap(SWITCH_SHORT_HOLD_MS);
        await new Promise((r) => setTimeout(r, SWITCH_MULTI_PRESS_GAP_MS));
        await tap(SWITCH_SHORT_HOLD_MS);
        await new Promise((r) => setTimeout(r, SWITCH_MULTI_PRESS_GAP_MS));
        await tap(SWITCH_SHORT_HOLD_MS);
        return;
    }
  }

  onCommand(listener: Emit): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }

  /**
   * § Phase 4 — reads `@matter/main`'s OWN live commissioning/fabric state directly off the
   * root endpoint (`node.state.commissioning`), never a SupremeOS-maintained copy. Verified
   * against `CommissioningServer`'s real (internal, `@matter/node`) source: `passcode`/
   * `discriminator` are schema-marked non-volatile (`quality: "N"`) — the SDK persists them to
   * `storagePath` itself and only generates a fresh value when none exists yet, which is
   * exactly the "generate once, reuse forever" behavior §2 requires. This function does not
   * generate or cache anything of its own.
   */
  getCommissioningState(): MatterBridgeCommissioningState {
    if (!this.node) throw new Error("matter-bridge: server not started");
    const commissioning = this.node.state.commissioning;
    const fabrics: MatterBridgeFabricInfo[] = Object.values(commissioning.fabrics).map((f) => ({
      fabricIndex: f.fabricIndex,
      label: f.label || null,
      rootVendorId: f.rootVendorId ?? null,
    }));
    // § Matter Bridge Phase 1.2B — § live-confirmed via a real repro (a fresh, never-commissioned
    // node's `administratorCommissioning.windowStatus` reads back 0/WindowNotOpen immediately
    // after `start()`, even though the node IS genuinely commissionable — confirmed by the SAME
    // repro's mDNS log showing "Publishing kind: commissionable"). The AdministratorCommissioning
    // cluster's `windowStatus` attribute only reflects an EXPLICIT `OpenCommissioningWindow`/
    // `OpenBasicCommissioningWindow` command having been issued — it is NOT set by the SDK's own
    // auto-opened-at-boot commissioning path (`CommissioningServer`'s internal
    // `#enterOnlineMode()`, documented on `getCommissioningState`'s own doc above), which
    // advertises/accepts PASE without ever driving that cluster's command flow. So
    // "commissionable right now" is genuinely `windowStatus !== 0` (an admin explicitly
    // (re)opened a window — e.g. to admit a SECOND ecosystem after the first) OR `!commissioned`
    // (the SDK's auto-opened window for a node with no fabric yet, which this bridge always
    // relies on for first pairing).
    const windowStatus = (this.node.state as unknown as { administratorCommissioning?: { windowStatus?: number } }).administratorCommissioning
      ?.windowStatus;
    const explicitWindowOpen = typeof windowStatus === "number" && windowStatus !== 0;
    return {
      commissioned: commissioning.commissioned,
      fabricCount: fabrics.length,
      commissioningWindowOpen: explicitWindowOpen || !commissioning.commissioned,
      fabrics,
      pairing: {
        manualPairingCode: commissioning.pairingCodes.manualPairingCode,
        qrPairingCode: commissioning.pairingCodes.qrPairingCode,
        discriminator: commissioning.discriminator,
      },
    };
  }

  /** § Phase 4 §7, § live-confirmed fix (Matter Bridge Phase 1.2A — the "internal error after
   * factory reset" production bug). Delegates to `ServerNode.erase()` — verified against its
   * REAL, installed source (`@matter/node/dist/esm/node/ServerNode.js`'s `eraseWithMutex`):
   * `erase()` clears `SessionManager`/`FabricManager`/`OccurrenceManager`/`ServerNodeStore`
   * (commissioning identity, fabrics, credentials) and then brings the SAME node instance BACK
   * ONLINE IN PLACE (`if (isOnline && shouldBeOnline) await this.startWithMutex()`) — it never
   * destructs/closes the node, and never touches its child endpoint tree (the aggregator and
   * every bridged device endpoint are untouched — `resetStorage()` only reaches the four
   * services named above). This means the node keeps holding its `@matter/nodejs`
   * `NodeJsDirectoryLock` on `storagePath` throughout.
   *
   * ROOT CAUSE this replaces: the previous version discarded `this.node`/`this.aggregator`/
   * `this.endpoints` here (`this.node = undefined`), on the incorrect assumption that `erase()`
   * destroys the node and a caller must build a fresh one — it does not. That orphaned the
   * STILL-ALIVE, STILL-ONLINE, STILL-LOCK-HOLDING node: nothing ever called `.close()` on it, so
   * its storage lock was never released. `MatterBridgeDriver.factoryReset()` immediately called
   * `start()` again, which (seeing `this.node` falsely `undefined`) tried `ServerNode.create()` a
   * SECOND time at the SAME `storagePath` — `@matter/nodejs`'s `acquireDirectoryLock` (`fs/
   * lock-utils.js`) found the existing lock file still owned by THIS process's pid/token and
   * threw `StorageLockError("Storage is already locked by this process")`, which surfaced to the
   * Extension Center only as the generic "internal error" (§6 error model). Worse, that orphaned
   * node/lock then lived for the rest of the gateway process's life — since it was never
   * referenced or closed again, every SUBSEQUENT Enable attempt (even after a Disable, which
   * closes the wrong — nulled-out, never-real — `this.node` reference) hit the identical
   * `StorageLockError`, exactly matching the reported "Disable → Enable still fails" symptom.
   *
   * Fix: do not null out or replace anything — the SAME `node`/`aggregator`/`endpoints` are still
   * genuinely valid after `erase()` returns (the SDK guarantees this), so nothing here needs
   * rebuilding. A caller does NOT need to call `start()` afterward; the node is already online. */
  async factoryReset(): Promise<void> {
    if (!this.node) throw new Error("matter-bridge: server not started");
    await this.node.erase();
  }
}
