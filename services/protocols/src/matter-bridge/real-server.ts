import { Environment, ServerNode, Endpoint, VendorId } from "@matter/main";
import { AggregatorEndpoint } from "@matter/main/endpoints/aggregator";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { OnOffServer } from "@matter/main/behaviors/on-off";
import { BridgedDeviceBasicInformationServer } from "@matter/main/behaviors/bridged-device-basic-information";
import type { MatterBridgeServer } from "./server.js";

/**
 * The real `@matter/main` implementation of {@link MatterBridgeServer} (§3, §26 — no manual
 * packet encoding, no parallel Matter stack: this file is the ONLY place that touches
 * `@matter/main` for the Bridge). This is the ONE file in Phase 1 that cannot be exercised in
 * this sandbox: opening real UDP/mDNS sockets and a real PASE/CASE commissioning handshake
 * needs a real LAN and a real controller (Apple/Google/Alexa/a reference controller) — see
 * §29. Everything above this file (`MatterBridgeDriver`, `MatterEndpointRegistry`) is
 * transport-agnostic and IS unit-tested, against a fake `MatterBridgeServer`.
 *
 * STATUS: verified against `@matter/main@0.17.9`'s real, installed TypeScript types
 * (`pnpm typecheck`) — this is real, but bounded, verification: it proves the API is called
 * the way this SDK version declares it, not that a real ecosystem accepts the result.
 * NOT VERIFIED — REQUIRES REAL HARDWARE / ECOSYSTEM: commissioning into Apple Home / Google
 * Home / Alexa / SmartThings, and operation over a real LAN.
 */

/** One instance of the OnOff behavior override per endpoint, so the command callback below
 * can identify WHICH endpoint's cluster command fired — `this.endpoint.number` is the same
 * stable endpoint number the {@link MatterEndpointRegistry} assigned when the endpoint was
 * added, closing the loop between the persisted mapping and the live Matter node. */
function createOnOffServerClass(onCommand: (endpointNumber: number, on: boolean) => void) {
  return class BridgedOnOffServer extends OnOffServer {
    override async on() {
      await super.on();
      const n = this.endpoint.number;
      if (n !== undefined) onCommand(n, true);
    }
    override async off() {
      await super.off();
      const n = this.endpoint.number;
      if (n !== undefined) onCommand(n, false);
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
   *     `setOnOffState` writes) — everything else under this directory.
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

/** The concrete endpoint type returned for a bridged On/Off Light — used instead of the bare
 * `Endpoint` so `setOnOffState`'s `endpoint.set({ onOff: {...} })` is checked against the
 * real OnOff cluster's state shape rather than the untyped default `{}` behavior set. */
type OnOffLightEndpoint = Endpoint<
  ReturnType<typeof OnOffLightDevice.with<[typeof BridgedDeviceBasicInformationServer, ReturnType<typeof createOnOffServerClass>]>>
>;

export class RealMatterBridgeServer implements MatterBridgeServer {
  private node: ServerNode | undefined;
  private aggregator: Endpoint | undefined;
  private readonly endpoints = new Map<number, OnOffLightEndpoint>();
  private readonly commandListeners = new Set<(endpointNumber: number, on: boolean) => void>();

  constructor(private readonly opts: RealMatterBridgeServerOptions) {}

  async start(): Promise<void> {
    if (this.node) return;
    const environment = Environment.default;
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

    this.aggregator = new Endpoint(AggregatorEndpoint, { id: "aggregator" });
    await this.node.add(this.aggregator);
    await this.node.start();
  }

  async stop(): Promise<void> {
    await this.node?.close();
    this.node = undefined;
    this.aggregator = undefined;
    this.endpoints.clear();
  }

  async addOnOffLight(args: { endpointNumber: number; name: string; initialOn: boolean }): Promise<void> {
    if (!this.aggregator) throw new Error("matter-bridge: server not started");
    if (this.endpoints.has(args.endpointNumber)) return; // idempotent (§ Endpoint architecture)

    const BridgedOnOffServer = createOnOffServerClass((endpointNumber, on) => {
      for (const l of this.commandListeners) l(endpointNumber, on);
    });

    const endpoint = new Endpoint(
      OnOffLightDevice.with(BridgedDeviceBasicInformationServer, BridgedOnOffServer),
      {
        id: `device-${args.endpointNumber}`,
        number: args.endpointNumber,
        bridgedDeviceBasicInformation: {
          nodeLabel: args.name,
          reachable: true,
        },
        onOff: { onOff: args.initialOn },
      },
    );
    await this.aggregator.add(endpoint);
    this.endpoints.set(args.endpointNumber, endpoint);
  }

  async removeEndpoint(endpointNumber: number): Promise<void> {
    const endpoint = this.endpoints.get(endpointNumber);
    if (!endpoint) return;
    await endpoint.delete();
    this.endpoints.delete(endpointNumber);
  }

  async setOnOffState(endpointNumber: number, on: boolean): Promise<void> {
    const endpoint = this.endpoints.get(endpointNumber);
    if (!endpoint) return;
    // A direct attribute write — this is a STATE REPORT, not a command invocation, so it does
    // NOT re-enter `BridgedOnOffServer.on()/off()` above (§11 loop-safety).
    await endpoint.set({ onOff: { onOff: on } });
  }

  onCommand(listener: (endpointNumber: number, on: boolean) => void): () => void {
    this.commandListeners.add(listener);
    return () => this.commandListeners.delete(listener);
  }
}
