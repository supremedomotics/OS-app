import net from "node:net";
import type {
  CapabilityCommand,
  CapabilityKind,
  CapabilityState,
  DeviceId,
} from "@supreme/domain-model";
import {
  bindingKey,
  type DiscoveredDevice,
  type INativeProtocolDriver,
  type MediaArtwork,
  type ProtocolBinding,
  type StateListener,
} from "@supreme/integration-layer";
import { buildMediaState, commandToAvr, denonCapabilityConfig, parseAvrLine, parseHostPort, type AvrZone } from "./avr-codec.js";
import { albumArtUrl, buildAppCommandRequests, parseDeletedSource, parseRenameSource } from "./avr-http-codec.js";
import { parseUpnpDescription } from "./yamaha-codec.js";
import { ssdpSearch, type SsdpResponse, type SsdpSearchOptions } from "./ssdp.js";
import { bestEffortMacForIp } from "./arp-lookup.js";
import type { DriverDiagnosticsSnapshot, DriverTraceEntry } from "./driver-diagnostics.js";
import { removeDeviceBindings, removeDeviceStates } from "./binding-cleanup.js";
import { recordCapabilityState } from "./av-sdk/state-cache.js";
import { TcpLineTransport, type TcpLink } from "./av-sdk/tcp-line-transport.js";
import { createProtocolTracer, type ProtocolTracer } from "./av-sdk/protocol-tracer.js";
import { AdaptivePoller, HttpPollClient } from "./av-sdk/http-poll-client.js";

/** Kept in sync with `supreme-avr`'s manifest `version` (services/drivers/src/manifests.ts)
 * — surfaced in Diagnostics so an installer can tell which driver build is running. */
const DRIVER_VERSION = "1.0.0";

export interface AvrDriverOptions {
  /** Default control port (Denon/Marantz Telnet = 23). */
  port?: number;
  /** Injectable socket factory (tests point at an in-process AVR server). */
  createSocket?: (host: string, port: number) => net.Socket;
  /** Reconnect backoff floor / ceiling (ms). Defaults 2_000 / 60_000. */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  /** Injectable SSDP searcher (tests); defaults to a real multicast M-SEARCH. */
  ssdp?: (opts?: SsdpSearchOptions) => Promise<SsdpResponse[]>;
  /** Injectable fetch (tests point at an in-process UPnP description server); defaults
   * to the real global fetch. Used only to enrich discover() results with manufacturer/
   * model/serial from the unit's UPnP device description XML (§ Production Bugfix
   * Sprint) — Telnet itself has no such query. */
  fetchImpl?: typeof fetch;
  /** Surfaces connection lifecycle events (connect/error) to the Extension Center's driver
   * log / system log — without this a socket that never connects fails completely silently. */
  onLog?: (level: "info" | "warn" | "error", message: string) => void;
  /** § Production Bugfix Sprint — when true (and `onLog` is set), every raw token sent,
   * every line received, and every discover()/getCapabilityConfig() call is logged in
   * full sequence via `onLog`, prefixed `[trace:avr]`. Off by default — this is a
   * debugging aid, not a normal-operation log level. */
  trace?: boolean;
  /** § Universal AVR SDK — port for the unit's HTTP AppCommand control interface
   * (renamed input names, hidden-input filtering, album art). Real, confirmed via
   * `denonavr`'s actual source: 8080 on 2016+ models. Pre-2016 units may use port 80
   * instead or lack this interface entirely — all use of it is best-effort and never
   * blocks Telnet control, matching this driver's existing UPnP-enrichment posture. */
  httpPort?: number;
  /** § Universal AVR SDK — builds the gateway's own artwork-proxy URL for a device
   * (`/v1/devices/:id/media/artwork`), same pattern the Apple TV driver already uses.
   * Absent (no artwork advertised) when the gateway has no public base URL configured. */
  artworkUrlFor?: (deviceId: DeviceId) => string;
}

interface AvrBinding {
  deviceId: DeviceId;
  capability: CapabilityKind;
  host: string;
  port: number;
  /** Which zone this binding controls — "main" (power/volume/mute/source/tone/DSP) or
   * "zone2" (power/volume/mute/source; no tone/DSP — those are main-zone-only). */
  zone: AvrZone;
  /** Installer-declared: does this unit have tone control (bass/treble)? Telnet has no
   * feature-query command (see avr-codec.ts), so this can't be wire-detected. */
  hasToneControl: boolean;
  /** Installer-declared: does this unit have Audyssey calibration (Dynamic EQ/MultEQ
   * mode/Reference Level/Dynamic Volume/DRC)? Defaults `false` — see
   * `denonCapabilityConfig`'s doc for why this is opt-in rather than opt-out like
   * `hasToneControl`. */
  hasAudyssey: boolean;
  /** UPnP device-description `<modelName>`/`<serialNumber>`, threaded through from
   * discovery's `bindConfig.model`/`bindConfig.serial` when present (§ Diagnostics
   * Console, § Production Bugfix Sprint) — same pattern HEOS's `model` already uses.
   * `null` for a manually-added device (no discovery step ran) or a unit whose UPnP
   * description didn't include them. */
  model: string | null;
  serial: string | null;
}

interface MediaCache {
  volume: number;
  volumeDb?: number;
  muted: boolean;
  source: string | null;
  bass?: number;
  treble?: number;
  soundMode?: string;
  sleepMinutes?: number | null;
  dynamicEq?: boolean;
  audysseyMode?: string;
  referenceLevel?: number;
  dynamicVolume?: string;
  drc?: string;
}

/**
 * Real AVR IP-control driver (§3) — Denon/Marantz receivers over their published ASCII
 * Telnet protocol. Each receiver is its own IP host, so this driver manages a TCP link
 * per bound host (auto-reconnected with capped backoff on drop), sends control tokens,
 * and parses the receiver's unsolicited status echoes into Supreme state. Confines all
 * AVR detail; emits pure Supreme capabilities.
 *
 * Zone 2 is modeled as its own Supreme device (its own deviceId, own room) bound to the
 * SAME host:port link as the main zone — the same "one connection, many Supreme devices"
 * pattern every multi-binding driver in this fleet already uses. Which zone a binding
 * targets comes from `ProtocolBinding.config.zone` ("main" | "zone2", default "main"),
 * set at commissioning — Telnet has no wire-level way to discover Zone 2 presence (the
 * spec documents it as a per-model footnote, not a queryable fact), so this is
 * installer-declared, exactly as `denonCapabilityConfig` in avr-codec.ts documents.
 */
export class AvrProtocolDriver implements INativeProtocolDriver {
  readonly protocol = "avr";
  private connected = false;
  private readonly opts: AvrDriverOptions;
  private readonly defaultPort: number;
  private readonly bindings: AvrBinding[] = [];
  private readonly devices = new Set<DeviceId>();
  private readonly transport: TcpLineTransport;
  private readonly states = new Map<string, CapabilityState>();
  private readonly media = new Map<DeviceId, MediaCache>();
  private readonly listeners = new Set<StateListener>();
  private readonly fetchImpl: typeof fetch;
  private readonly tracer: ProtocolTracer;
  private readonly httpPort: number;
  /** § Universal AVR SDK — the second, HTTP-based transport (renamed inputs,
   * hidden-input filtering, album art) that makes this a genuinely multi-transport
   * driver: `TcpLineTransport` above stays the sole realtime-event channel (nothing
   * about it changes), this covers the one real gap Telnet cannot fill. */
  private readonly httpClient: HttpPollClient;
  /** Real, receiver-reported input enrichment, keyed by `host:port` (shared by every
   * zone binding on that host — renamed/hidden inputs are a whole-unit concept, not
   * per-zone). Absent for a host never successfully enriched yet — callers fall back to
   * the installer-declared default labels, exactly as before this feature existed. */
  private readonly inputEnrichment = new Map<string, { renamed: Map<string, string>; hidden: Set<string> }>();
  /** One slow, adaptive-backoff poller per host — the concrete mechanism keeping
   * renamed/hidden inputs in sync with changes made via the OEM Denon Remote app
   * (Telnet has no push notification for a rename; see module doc). */
  private readonly enrichmentPollers = new Map<string, AdaptivePoller>();

  constructor(opts: AvrDriverOptions = {}) {
    this.opts = opts;
    this.defaultPort = opts.port ?? 23;
    this.httpPort = opts.httpPort ?? 8080;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.tracer = createProtocolTracer("avr", opts.trace === true, opts.onLog);
    this.httpClient = new HttpPollClient({ fetchImpl: this.fetchImpl, tracer: this.tracer });
    this.transport = new TcpLineTransport({
      delimiter: "\r",
      reconnectBaseMs: opts.reconnectBaseMs,
      reconnectMaxMs: opts.reconnectMaxMs,
      createSocket: opts.createSocket,
      onLog: opts.onLog,
      onConnect: (link, socket, host, port) => this.onLinkConnect(link, socket, host, port),
      onLine: (ctx, line) => this.onLine(ctx.host, ctx.port, line),
    });
  }

  async connect(): Promise<void> {
    // Receivers connect lazily per bound host; nothing global to open.
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.transport.disconnectAll();
    for (const poller of this.enrichmentPollers.values()) poller.stop();
    this.enrichmentPollers.clear();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async bind(binding: ProtocolBinding): Promise<void> {
    const { host, port } = parseHostPort(binding.address, this.defaultPort);
    const key = `${host}:${port}`;
    const zone: AvrZone = binding.config?.zone === "zone2" ? "zone2" : "main";
    const hasToneControl = binding.config?.hasToneControl !== false;
    const hasAudyssey = binding.config?.hasAudyssey === true;
    const model = typeof binding.config?.model === "string" ? binding.config.model : null;
    const serial = typeof binding.config?.serial === "string" ? binding.config.serial : null;
    const isFirstZone2Binding = zone === "zone2" && !this.bindings.some((b) => `${b.host}:${b.port}` === key && b.zone === "zone2");
    const isFirstBindingForHost = !this.bindings.some((b) => `${b.host}:${b.port}` === key);
    // § Universal AVR SDK — seed enrichment synchronously from discover()'s preview
    // data when the wizard already fetched it, so a freshly-commissioned device shows
    // real renamed labels immediately rather than waiting for the async refresh below
    // to resolve. Same pattern `model`/`serial` already use.
    if (isFirstBindingForHost && (binding.config?.renamedInputs || binding.config?.hiddenInputs)) {
      const renamedRaw = binding.config?.renamedInputs;
      const hiddenRaw = binding.config?.hiddenInputs;
      this.inputEnrichment.set(key, {
        renamed: renamedRaw && typeof renamedRaw === "object" ? new Map(Object.entries(renamedRaw as Record<string, string>)) : new Map(),
        hidden: Array.isArray(hiddenRaw) ? new Set(hiddenRaw as string[]) : new Set(),
      });
    }
    this.bindings.push({ deviceId: binding.deviceId, capability: binding.capability, host, port, zone, hasToneControl, hasAudyssey, model, serial });
    this.devices.add(binding.deviceId);
    if (binding.capability === "media" && !this.media.has(binding.deviceId)) {
      this.media.set(binding.deviceId, { volume: 0, muted: false, source: null });
    }
    if (this.connected) {
      const link = this.transport.ensureLink(key, host, port);
      // A zone2 device bound AFTER its link already finished connecting (e.g. zone1 and
      // zone2 added as two separate commission calls, as the guided AVR add wizard does)
      // never gets `onLinkConnect`'s Z2?/Z2MU? — that init burst already fired without
      // them, since no zone2 binding existed yet at that moment. Catch up immediately
      // instead of leaving zone2's state stuck at null until the next reconnect.
      if (isFirstZone2Binding && link.ready && link.socket && !link.socket.destroyed) {
        const tokens = ["Z2?", "Z2MU?"];
        for (const t of tokens) link.diagnostics.recordSend(t);
        link.socket.write(`${tokens.join("\r")}\r`);
      }
      // § Universal AVR SDK — first binding for this host: fetch real renamed/hidden
      // inputs (best-effort, never blocks Telnet binding) and start the slow
      // consistency poller that keeps catching OEM-app-driven renames.
      if (isFirstBindingForHost) {
        void this.refreshInputEnrichment(host, port);
        this.ensureEnrichmentPoller(host, port);
      }
    }
  }

  manages(deviceId: DeviceId): boolean {
    return this.devices.has(deviceId);
  }

  /** § Driver Lifecycle Completion — releases this one device's bindings/cached
   * state/media cache, and additionally tears down its TCP link (reconnect scheduler +
   * socket) once no other bound device (e.g. main zone / zone2 sharing the same
   * host:port) still uses it. Idempotent. */
  async unbind(deviceId: DeviceId): Promise<void> {
    const removed = this.bindings.filter((b) => b.deviceId === deviceId);
    removeDeviceBindings(this.bindings, deviceId);
    this.devices.delete(deviceId);
    removeDeviceStates(this.states, deviceId);
    this.media.delete(deviceId);
    const releasedKeys = new Set(removed.map((b) => `${b.host}:${b.port}`));
    for (const key of releasedKeys) {
      if (this.bindings.some((b) => `${b.host}:${b.port}` === key)) continue;
      this.transport.releaseKey(key);
      this.httpClient.releaseKey(key);
      this.inputEnrichment.delete(key);
      this.enrichmentPollers.get(key)?.stop();
      this.enrichmentPollers.delete(key);
    }
  }

  async command(deviceId: DeviceId, command: CapabilityCommand): Promise<void> {
    // § Production Hardening — Driver Lifecycle audit: without this, a command issued
    // after disconnect() silently re-opened a brand-new TCP socket via ensureLink()
    // instead of failing — the driver is supposed to be torn down at that point, not
    // quietly resurrect a connection behind the caller's back.
    if (!this.connected) throw new Error(`avr: driver is disconnected — cannot command ${deviceId}`);
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === command.capability);
    if (!b) throw new Error(`avr: ${deviceId} not bound for ${command.capability}`);
    const prev = this.states.get(bindingKey(deviceId, command.capability)) ?? null;
    const tokens = commandToAvr(command, prev, b.zone);
    if (!tokens) throw new Error(`avr: unsupported command for ${command.capability} (zone ${b.zone})`);
    const link = this.transport.ensureLink(`${b.host}:${b.port}`, b.host, b.port);
    // A dropped/never-established/still-connecting socket must fail LOUDLY — silently
    // swallowing the write (the previous behavior) reports "success" for a command the
    // receiver never saw. `ready` (not just `socket !== null`) matters: ensureLink() may have
    // just started a brand-new connection attempt that hasn't finished yet.
    if (!link.ready || !link.socket || link.socket.destroyed) {
      throw new Error(`avr: not connected to ${b.host}:${b.port} — check the receiver's IP and that Network Control/Telnet is enabled`);
    }
    this.tracer.event(`command ${deviceId} ${command.capability}/${"action" in command ? command.action : "?"} -> [${tokens.join(", ")}]`);
    for (const t of tokens) {
      link.diagnostics.recordSend(t);
      this.tracer.send(t);
      link.socket.write(`${t}\r`);
    }
  }

  getState(deviceId: DeviceId, capability: CapabilityKind): CapabilityState | null {
    return this.states.get(bindingKey(deviceId, capability)) ?? null;
  }

  getCapabilityConfig(deviceId: DeviceId, capability: CapabilityKind): Record<string, unknown> | null {
    if (capability !== "media") return null;
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "media");
    if (!b) return null;
    const hasZone2 = this.bindings.some((x) => x.host === b.host && x.port === b.port && x.zone === "zone2");
    const enrichment = this.inputEnrichment.get(`${b.host}:${b.port}`);
    this.tracer.event(
      `getCapabilityConfig ${deviceId} — hasZone2=${hasZone2}, hasToneControl=${b.hasToneControl}, ` +
        `renamedInputs=${enrichment?.renamed.size ?? 0}, hiddenInputs=${enrichment?.hidden.size ?? 0}`,
    );
    return denonCapabilityConfig({
      hasZone2,
      hasToneControl: b.zone === "main" && b.hasToneControl,
      hasAudyssey: b.zone === "main" && b.hasAudyssey,
      renamedInputs: enrichment?.renamed,
      hiddenInputs: enrichment?.hidden,
    }) as unknown as Record<string, unknown>;
  }

  /** § Capability Refresh (Part 2) — the classic Denon/Marantz Telnet protocol has no
   * feature-query command at all (verified against the spec, see avr-codec.ts module
   * doc), so there is no new capability data to discover over the wire; `hasZone2`/
   * `hasToneControl` stay whatever the installer declared at commissioning. What this
   * genuinely does: force the link closed and immediately re-open it, which re-runs
   * `onLinkConnect`'s init query burst — the same real state resync a natural
   * reconnect performs, just triggered on demand instead of waiting for a drop. Also
   * (§ Universal AVR SDK) force-refreshes real renamed/hidden inputs over HTTP —
   * unlike Telnet, this genuinely CAN report new data on demand. */
  async refreshCapabilities(deviceId: DeviceId): Promise<void> {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b || !this.connected) return;
    const key = `${b.host}:${b.port}`;
    this.transport.releaseKey(key);
    this.transport.ensureLink(key, b.host, b.port);
    void this.refreshInputEnrichment(b.host, b.port);
  }

  /** § Universal AVR SDK — fetches real renamed/hidden inputs via the confirmed-real
   * HTTP AppCommand interface. Best-effort: any failure (older non-2016 unit with no
   * HTTP interface on this port, network hiccup, …) leaves the existing enrichment (or
   * none) untouched rather than clearing real data on a transient error — matches this
   * driver's existing UPnP-enrichment posture in `discover()`. */
  private async refreshInputEnrichment(host: string, port: number): Promise<void> {
    const key = `${host}:${port}`;
    try {
      const [body] = buildAppCommandRequests([
        { id: "1", text: "GetRenameSource" },
        { id: "1", text: "GetDeletedSource" },
      ]);
      this.tracer.event(`refreshInputEnrichment: POST AppCommand.xml to ${host}:${this.httpPort}`);
      const xml = await this.httpClient.request(`${key}:appcommand`, `http://${host}:${this.httpPort}/goform/AppCommand.xml`, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body,
      });
      const renamed = parseRenameSource(xml);
      const hidden = parseDeletedSource(xml);
      this.inputEnrichment.set(key, { renamed, hidden });
      this.tracer.event(`refreshInputEnrichment: ${host} — ${renamed.size} renamed, ${hidden.size} hidden`);
    } catch (err) {
      this.tracer.event(`refreshInputEnrichment: ${host} failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** § Universal AVR SDK — one slow (15-minute), adaptive-backoff poller per host that
   * keeps renamed/hidden inputs in sync with changes made via the OEM Denon Remote app
   * (Telnet has no push notification for a rename). Pauses automatically (no ticking)
   * while this host's link isn't connected, and resumes on its own once it reconnects —
   * `AdaptivePoller`'s `intervalMs` is re-evaluated fresh on every scheduling decision. */
  private ensureEnrichmentPoller(host: string, port: number): void {
    const key = `${host}:${port}`;
    if (this.enrichmentPollers.has(key)) return;
    const poller = new AdaptivePoller({
      intervalMs: () => (this.transport.diagnosticsFor(key).status === "connected" ? 15 * 60 * 1000 : null),
      tick: () => this.refreshInputEnrichment(host, port),
    });
    this.enrichmentPollers.set(key, poller);
    poller.start();
  }

  /** § Universal AVR SDK — real album art, fetched from the unit's own confirmed-static
   * HTTP endpoint (`albumArtUrl()`, no XML/schema involved). `null` on any failure
   * (older non-2016 unit with no HTTP interface, network hiccup, nothing currently
   * displayed) — never fabricated placeholder bytes. */
  async getArtwork(deviceId: DeviceId): Promise<MediaArtwork | null> {
    const b = this.bindings.find((x) => x.deviceId === deviceId && x.capability === "media");
    if (!b) return null;
    try {
      const res = await this.fetchImpl(albumArtUrl(b.host, this.httpPort));
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") ?? "image/png";
      const data = new Uint8Array(await res.arrayBuffer());
      return { contentType, data };
    } catch {
      return null;
    }
  }

  /** Diagnostics Console (§ Universal AV Driver SDK) — real per-link counters/timestamps,
   * never fabricated. `null` when this device's zone/host has no link yet (never bound or
   * never connected). MAC is a best-effort local ARP-table read (§ arp-lookup.ts); the
   * classic Telnet protocol itself exposes no model/firmware/serial on the wire (verified
   * against the spec, see avr-codec.ts module doc) — `firmware` stays honestly `null`
   * always, but `model`/`serial` ARE available when this device was discovered (not
   * manually added), threaded through from the SAME physical unit's UPnP device
   * description XML fetched at discovery time (§ Production Bugfix Sprint, see
   * discover() below) — real data from a real, different wire source, not Telnet
   * pretending to have a capability it doesn't. */
  getDiagnostics(deviceId: DeviceId): DriverDiagnosticsSnapshot | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const { status, diagnostics } = this.transport.diagnosticsFor(`${b.host}:${b.port}`);
    return diagnostics.snapshot(status, {
      protocol: this.protocol,
      driverVersion: DRIVER_VERSION,
      model: b.model,
      firmware: null,
      serial: b.serial,
      ip: b.host,
      mac: bestEffortMacForIp(b.host),
    });
  }

  /** § Universal AVR SDK — this device's raw renamed/hidden input enrichment, keyed
   * only by which HOST it's bound to (NOT by capability, unlike `getCapabilityConfig()`
   * which requires a `media` binding) — used by the manual-add probe, which only binds
   * `onoff` for a fast reachability check but still benefits from showing real renamed
   * labels during commissioning. `null` when this device isn't bound, or the host's
   * enrichment hasn't resolved yet (still in flight, or genuinely unreachable). */
  getInputEnrichment(deviceId: DeviceId): { renamed: Record<string, string>; hidden: string[] } | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    const enrichment = this.inputEnrichment.get(`${b.host}:${b.port}`);
    if (!enrichment) return null;
    return { renamed: Object.fromEntries(enrichment.renamed), hidden: [...enrichment.hidden] };
  }

  /** § Universal AVR SDK — this device's owning link's recent raw protocol trace, read
   * straight off the SAME `DriverDiagnosticsTracker` `getDiagnostics()` already reads
   * (its ring buffer is populated automatically by every real `recordSend`/
   * `recordReceive` call, independent of the separate opt-in `trace`/`onLog` option). */
  getTrace(deviceId: DeviceId): DriverTraceEntry[] | null {
    const b = this.bindings.find((x) => x.deviceId === deviceId);
    if (!b) return null;
    return this.transport.diagnosticsFor(`${b.host}:${b.port}`).diagnostics.recentTrace();
  }

  async discover(): Promise<DiscoveredDevice[]> {
    // The classic Telnet control protocol itself defines no SSDP presence (verified:
    // none is documented in the spec) — but every Denon/Marantz unit that exposes
    // Telnet also ships HEOS (standard across the lineup since ~2014, same physical
    // receiver), which DOES answer SSDP on this Denon-defined search target. This is
    // therefore "co-located discovery": finding the HEOS presence to locate the same
    // box's Telnet port (23, this driver's default), not a wire-verified Telnet
    // capability. An installer should confirm Network Control / Telnet is enabled in
    // the unit's setup menu before binding — some models ship it off by default.
    const search = this.opts.ssdp ?? ssdpSearch;
    this.tracer.event("discover: SSDP M-SEARCH st=urn:schemas-denon-com:device:ACT-Denon:1");
    const responses = await search({ st: "urn:schemas-denon-com:device:ACT-Denon:1" });
    this.tracer.event(`discover: ${responses.length} candidate(s) — [${responses.map((r) => r.address).join(", ")}]`);
    return Promise.all(responses.map(async (r) => {
      // § Production Bugfix Sprint — the SAME co-located SSDP response already carries
      // a `LOCATION` pointing at the unit's standard UPnP device description XML
      // (every SSDP-answering device publishes one; this isn't Denon-specific), which
      // genuinely contains <manufacturer>/<modelName>/<serialNumber> — real wire data,
      // evidenced against the ol-iver/denonavr library's own SSDP parser (the library
      // Home Assistant's official Denon integration is built on). Telnet itself still
      // has none of these; this is a different, real source for the same physical box,
      // not a fabricated Telnet capability. Best-effort: a fetch/parse failure here
      // must not fail discovery of the unit itself.
      let manufacturer: string | null = null;
      let modelName: string | null = null;
      let serialNumber: string | null = null;
      if (r.location) {
        try {
          this.tracer.event(`discover: fetching UPnP description ${r.location}`);
          const res = await this.fetchImpl(r.location);
          if (res.ok) {
            const xml = await res.text();
            ({ manufacturer, modelName, serialNumber } = parseUpnpDescription(xml));
            this.tracer.event(`discover: UPnP description ${r.address} — manufacturer=${manufacturer ?? "?"} model=${modelName ?? "?"} serial=${serialNumber ?? "?"}`);
          } else {
            this.tracer.event(`discover: UPnP description fetch for ${r.address} returned HTTP ${res.status}`);
          }
        } catch (err) {
          this.tracer.event(`discover: UPnP description fetch for ${r.address} failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // § Universal AVR SDK — best-effort real renamed/hidden inputs during discovery
      // itself, so the guided wizard can show an installer's real "DIRECTV"/"Blu-ray
      // Player" labels before they even finish commissioning, not just after the first
      // bind. Same non-fatal posture as the UPnP step above — a fetch failure (older
      // unit with no HTTP interface, wrong port) never fails discovery of the unit.
      let renamedInputs: Record<string, string> | undefined;
      let hiddenInputs: string[] | undefined;
      try {
        const [body] = buildAppCommandRequests([
          { id: "1", text: "GetRenameSource" },
          { id: "1", text: "GetDeletedSource" },
        ]);
        this.tracer.event(`discover: fetching AppCommand input enrichment for ${r.address}`);
        const res = await this.fetchImpl(`http://${r.address}:${this.httpPort}/goform/AppCommand.xml`, {
          method: "POST",
          headers: { "content-type": "text/xml" },
          body,
        });
        if (res.ok) {
          const xml = await res.text();
          const renamed = parseRenameSource(xml);
          const hidden = parseDeletedSource(xml);
          if (renamed.size > 0) renamedInputs = Object.fromEntries(renamed);
          if (hidden.size > 0) hiddenInputs = [...hidden];
          this.tracer.event(`discover: AppCommand input enrichment for ${r.address} — ${renamed.size} renamed, ${hidden.size} hidden`);
        }
      } catch (err) {
        this.tracer.event(`discover: AppCommand input enrichment for ${r.address} failed — ${err instanceof Error ? err.message : String(err)}`);
      }
      return {
        backendId: r.address,
        suggestedName: `AVR ${r.address}`,
        capabilities: ["onoff", "media"] as DiscoveredDevice["capabilities"],
        raw: {
          ip: r.address,
          server: r.server ?? null,
          location: r.location ?? null,
          ...(manufacturer ? { manufacturer } : {}),
          ...(renamedInputs ? { renamedInputs } : {}),
          ...(hiddenInputs ? { hiddenInputs } : {}),
          bindConfig: {
            zone: "main",
            ...(modelName ? { model: modelName } : {}),
            ...(serialNumber ? { serial: serialNumber } : {}),
          },
        },
      };
    }));
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** `TcpLineTransport`'s `onConnect` hook — the one genuinely Denon/Marantz-specific piece
   * of what used to be `openSocket()`'s connect handler (link readiness/reconnect-reset/the
   * "Connected to…" log line are now owned by the transport itself). Queries current state
   * so the driver starts in sync (main zone + zone 2 if bound). */
  private onLinkConnect(link: TcpLink, socket: net.Socket, host: string, port: number): void {
    const initTokens = ["PW?", "ZM?", "MV?", "MU?", "SI?", "PSTONE CTRL ?", "PSBAS ?", "PSTRE ?", "MS?"];
    if (this.bindings.some((b) => `${b.host}:${b.port}` === `${host}:${port}` && b.zone === "zone2")) {
      initTokens.push("Z2?", "Z2MU?");
    }
    // § Universal AVR SDK — Audyssey-family (see avr-codec.ts module doc). Only queried
    // when the installer has declared this unit has Audyssey — an unnecessary query on a
    // unit without it just gets silently ignored by the receiver, but there's no reason
    // to spend the round-trip on every connect for a control this binding won't expose.
    if (this.bindings.some((b) => `${b.host}:${b.port}` === `${host}:${port}` && b.zone === "main" && b.hasAudyssey)) {
      initTokens.push("PSDYNEQ ?", "PSMULTEQ: ?", "PSREFLEV ?", "PSDYNVOL ?", "PSDRC ?");
    }
    this.tracer.event(`connected to ${host}:${port} — sending init query burst: [${initTokens.join(", ")}]`);
    for (const t of initTokens) {
      link.diagnostics.recordSend(t);
      this.tracer.send(t);
    }
    socket.write(`${initTokens.join("\r")}\r`);
  }

  private onLine(host: string, port: number, line: string): void {
    this.tracer.receive(line);
    const update = parseAvrLine(line);
    // § Production Bugfix Sprint ("no realtime feedback for any zone") — a line the
    // receiver genuinely sent but this codec doesn't recognize is exactly the kind of
    // thing that needs to be visible during debugging, not silently dropped. Traced
    // distinctly from a successfully-parsed line so a captured trace immediately shows
    // whether the receiver is talking at all (lines arriving, none recognized — a real
    // codec gap) versus not talking at all (no `<-` lines ever appear in the trace —
    // points at Network Control/Telnet being disabled on the unit, or nothing actually
    // connected).
    if (!update) {
      this.tracer.event(`unrecognized line from ${host}:${port}: ${JSON.stringify(line)}`);
      return;
    }
    switch (update.kind) {
      case "power":
        this.emitFor(host, port, "onoff", "main", { kind: "onoff", on: update.on });
        return;
      case "zone2Power":
        this.emitFor(host, port, "onoff", "zone2", { kind: "onoff", on: update.on });
        return;
      case "volume":
        this.patchMedia(host, port, "main", (c) => { c.volume = update.volume; c.volumeDb = update.volumeDb; });
        return;
      case "mute":
        this.patchMedia(host, port, "main", (c) => { c.muted = update.muted; });
        return;
      case "source":
        this.patchMedia(host, port, "main", (c) => { c.source = update.source; });
        return;
      case "bass":
        this.patchMedia(host, port, "main", (c) => { c.bass = update.bass; });
        return;
      case "treble":
        this.patchMedia(host, port, "main", (c) => { c.treble = update.treble; });
        return;
      case "soundMode":
        this.patchMedia(host, port, "main", (c) => { c.soundMode = update.mode; });
        return;
      case "zone2Mute":
        this.patchMedia(host, port, "zone2", (c) => { c.muted = update.muted; });
        return;
      case "zone2Volume":
        this.patchMedia(host, port, "zone2", (c) => { c.volume = update.volume; c.volumeDb = update.volumeDb; });
        return;
      case "zone2Source":
        this.patchMedia(host, port, "zone2", (c) => { c.source = update.source; });
        return;
      case "sleep":
        this.patchMedia(host, port, "main", (c) => { c.sleepMinutes = update.minutes; });
        return;
      case "dynamicEq":
        this.patchMedia(host, port, "main", (c) => { c.dynamicEq = update.on; });
        return;
      case "audysseyMode":
        this.patchMedia(host, port, "main", (c) => { c.audysseyMode = update.mode; });
        return;
      case "referenceLevel":
        this.patchMedia(host, port, "main", (c) => { c.referenceLevel = update.db; });
        return;
      case "dynamicVolume":
        this.patchMedia(host, port, "main", (c) => { c.dynamicVolume = update.mode; });
        return;
      case "drc":
        this.patchMedia(host, port, "main", (c) => { c.drc = update.mode; });
        return;
    }
  }

  private patchMedia(host: string, port: number, zone: AvrZone, patch: (cache: MediaCache) => void): void {
    const mediaBinding = this.bindings.find((b) => b.host === host && b.port === port && b.capability === "media" && b.zone === zone);
    if (!mediaBinding) return;
    const cache = this.media.get(mediaBinding.deviceId) ?? { volume: 0, muted: false, source: null };
    patch(cache);
    this.media.set(mediaBinding.deviceId, cache);
    // § Universal AVR SDK — album art is a whole-unit, front-panel-display concept
    // (Zone 2 has no display of its own), so only the main zone ever advertises it.
    // Advertises the gateway's OWN proxy URL (never the receiver's raw LAN URL — see
    // module doc/capability matrix for why: remote-access/mTLS-tunnel clients aren't
    // guaranteed to share a network with the receiver) — real bytes only flow through
    // `getArtwork()` on an actual client request, this never fetches eagerly.
    const artworkUrl = zone === "main" && this.opts.artworkUrlFor ? this.opts.artworkUrlFor(mediaBinding.deviceId) : null;
    this.record(mediaBinding.deviceId, "media", buildMediaState(cache, artworkUrl));
  }

  private emitFor(host: string, port: number, capability: CapabilityKind, zone: AvrZone, state: CapabilityState): void {
    const b = this.bindings.find((x) => x.host === host && x.port === port && x.capability === capability && x.zone === zone);
    if (b) this.record(b.deviceId, capability, state);
  }

  private record(deviceId: DeviceId, capability: CapabilityKind, state: CapabilityState): void {
    recordCapabilityState(this.states, this.listeners, deviceId, capability, state);
  }
}
