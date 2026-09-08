import { Environment, ServerNode, Endpoint, VendorId, Logger, LogLevel } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { ColorTemperatureLightDevice, ColorTemperatureLightRequirements } from "@matter/main/devices/color-temperature-light";
import { ExtendedColorLightDevice, ExtendedColorLightRequirements } from "@matter/main/devices/extended-color-light";
import { WindowCoveringDevice } from "@matter/main/devices/window-covering";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { LevelControlServer } from "@matter/main/behaviors/level-control";
import { WindowCoveringServer, MovementType, MovementDirection } from "@matter/main/behaviors/window-covering";
import { WindowCovering } from "@matter/main/clusters/window-covering";
import { ColorControl } from "@matter/main/clusters/color-control";
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
const DIMMABLE_LIGHT = 0x0101;
const COLOR_TEMPERATURE_LIGHT = 0x010c;
const EXTENDED_COLOR_LIGHT = 0x010d;
const WINDOW_COVERING = 0x0202;

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
      default:
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
