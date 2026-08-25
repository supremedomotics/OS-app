import { useCallback, useEffect, useState } from "react";
import { Button, StatusDot } from "@supreme/aureon-web";
import { useLive, type DriverConnectionState } from "./live.js";
import {
  type CasambiDiagnostics,
  type CasambiNameSyncResult,
  type CasambiTestConnectionResult,
  type CasambiUdpPacketTrace,
  connectDriver,
  discoverCasambiLocalGateway,
  discoverKnxGateways,
  type DriverConfigField,
  type DriverEntry,
  type DriverHealth,
  fetchCasambiDiagnostics,
  fetchCasambiReceivePipeline,
  fetchDriverHealth,
  fetchDriverLogs,
  fetchDriverRegistry,
  getDriverConfig,
  installDriverByKey,
  type KnxGateway,
  type ReceiveCertification,
  setDriverConfig,
  setDriverEnabled,
  syncCasambiNamesFromCloud,
  testCasambiLocalConnection,
  uninstallDriver,
  updateDriverByKey,
} from "./api.js";
import { KnxDiscoveryWorkspace } from "./knx-discovery-workspace.js";

/**
 * Driver Manager (§9 Driver Framework). Populates entirely from the driver REGISTRY, so any current
 * or future driver appears automatically. Each driver expands to a schema-GENERATED config page plus
 * install / enable / connect / health / logs controls. Fully responsive — the same component on
 * desktop, tablet and mobile.
 */
export function DriverManager() {
  const [drivers, setDrivers] = useState<DriverEntry[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  async function load() {
    setDrivers(await fetchDriverRegistry());
  }
  useEffect(() => {
    void load();
  }, []);

  return (
    <section className="card-section">
      <h2 className="section-title">Drivers &amp; integrations</h2>
      <p className="sub">Add, configure and monitor every protocol and device integration.</p>
      {drivers === null && <p className="muted">Loading…</p>}
      {drivers?.length === 0 && <p className="muted">No drivers available.</p>}
      <div className="drv-list">
        {(drivers ?? []).map((d) => (
          <DriverRow key={d.key} driver={d} expanded={open === d.key} onToggle={() => setOpen(open === d.key ? null : d.key)} onChanged={load} />
        ))}
      </div>
    </section>
  );
}

/** `connected` is the driver's REAL native-protocol connection state (§ production
 * defect: this badge used to read "Active" purely from install/enable bookkeeping,
 * even when the underlying tunnel/bus had never connected or had dropped — installed
 * v.s. enabled is a config fact; connected is a runtime fact, and the two can and do
 * diverge). Omitted/`null` (health hasn't loaded yet, or this driver has no live
 * protocol instance to check at all) falls back to the install/enable-only verdict
 * rather than claiming a real-time state that isn't actually known — never a guess in
 * either direction. */
export function statusLabel(d: DriverEntry, connected?: boolean | null): { text: string; cls: string } {
  if (!d.installed) return { text: "Not installed", cls: "off" };
  if (!d.enabled) return { text: "Disabled", cls: "off" };
  if (d.status === "error") return { text: "Error", cls: "err" };
  if (connected === false) return { text: "Disconnected", cls: "err" };
  return { text: "Active", cls: "ok" };
}

/** § Realtime State Architecture — command state ("connecting"/"disconnecting") is never
 * shown as equivalent to the confirmed outcome; each has its own label/class so the UI
 * can never claim "Connected" before the backend has actually said so. */
const DRIVER_CONNECTION_LABEL: Record<DriverConnectionState, { text: string; cls: string }> = {
  connecting: { text: "Connecting…", cls: "pending" },
  connected: { text: "Connected", cls: "ok" },
  disconnecting: { text: "Disconnecting…", cls: "pending" },
  disconnected: { text: "Disconnected", cls: "err" },
  error: { text: "Error", cls: "err" },
};

/** Merges the driver's install/enable/error facts with whatever the realtime layer
 * currently knows about its LIVE connection state, preferring the live signal once one
 * exists (§16 Initial State + Realtime State: initial snapshot until the first event,
 * the event thereafter — never both fighting for the same badge). */
export function liveStatusLabel(d: DriverEntry, live: DriverConnectionState | undefined, connected?: boolean | null): { text: string; cls: string } {
  if (!d.installed) return { text: "Not installed", cls: "off" };
  if (!d.enabled) return { text: "Disabled", cls: "off" };
  if (live) return DRIVER_CONNECTION_LABEL[live];
  return statusLabel(d, connected);
}

function DriverRow({ driver, expanded, onToggle, onChanged }: { driver: DriverEntry; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  // Real connection state, not just install/enable — see `statusLabel`'s doc comment.
  // Only fetched for drivers where it's meaningful (installed + enabled); "Not
  // installed"/"Disabled" is already the honest, complete answer without a health call.
  // This REST fetch is the INITIAL snapshot only (§16) — `useLive()`'s driverStates below
  // is what keeps the badge current afterward, without a refresh or remount.
  const [connected, setConnected] = useState<boolean | null | undefined>(undefined);
  const { driverStates } = useLive();
  useEffect(() => {
    if (!driver.installed || !driver.enabled || !driver.installedId) return;
    let cancelled = false;
    void fetchDriverHealth(driver.installedId).then((h) => {
      if (!cancelled) setConnected(h?.connected ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [driver.installedId, driver.installed, driver.enabled]);
  const live = driver.installedId ? driverStates[driver.installedId]?.state : undefined;
  const s = liveStatusLabel(driver, live, connected);
  return (
    <div className={`drv-row${expanded ? " open" : ""}`}>
      <button className="drv-head" onClick={onToggle}>
        <div className="drv-title">
          <span className="nm">{driver.name}</span>
          <span className="meta">{driver.category} · v{driver.version}{driver.requiresSku ? ` · ${driver.requiresSku}` : ""}</span>
        </div>
        <span className={`drv-badge ${s.cls}`}>{s.text}</span>
        <span className="drv-chev">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && <DriverDetail driver={driver} onChanged={onChanged} />}
    </div>
  );
}

export function DriverDetail({ driver, onChanged }: { driver: DriverEntry; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [schema, setSchema] = useState<DriverConfigField[]>(driver.configSchema);
  const [values, setValues] = useState<Record<string, unknown>>(driver.config ?? {});
  const [health, setHealth] = useState<DriverHealth | null>(null);
  const { driverStates, applyDriverState } = useLive();
  const [logs, setLogs] = useState<{ ts: string; level: string; message: string }[]>([]);

  useEffect(() => {
    if (!driver.installed || !driver.installedId) return;
    void getDriverConfig(driver.installedId).then((c) => {
      setSchema(c.schema);
      setValues(c.config);
    });
    void fetchDriverHealth(driver.installedId).then(setHealth);
    void fetchDriverLogs(driver.installedId).then(setLogs);
  }, [driver.installedId, driver.installed]);

  async function run(fn: () => Promise<void>, okMsg: string) {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(okMsg);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Action failed.");
    } finally {
      setBusy(false);
    }
  }

  const id = driver.installedId ?? "";
  const has = (op: string) => driver.operations.includes(op);
  const isProtocol = driver.protocols.length > 0;

  return (
    <div className="drv-detail">
      {driver.description && <p className="muted">{driver.description}</p>}

      {/* About — the extension's real metadata (§ Extension Center rich fields). Only fields the
          registry genuinely exposes are shown; nothing is fabricated. */}
      <dl className="drv-about">
        <div><dt>Developer</dt><dd>{driver.publisher}</dd></div>
        <div><dt>Version</dt><dd>v{driver.version}{driver.installed && driver.installedVersion && driver.installedVersion !== driver.version ? ` (installed v${driver.installedVersion})` : ""}</dd></div>
        <div><dt>Channel</dt><dd>{driver.channel}</dd></div>
        <div><dt>Category</dt><dd>{driver.category}</dd></div>
        {driver.hubMinVersion && <div><dt>Compatibility</dt><dd>Supreme OS ≥ v{driver.hubMinVersion}</dd></div>}
        {driver.requiresSku && <div><dt>Requires license</dt><dd>{driver.requiresSku}</dd></div>}
        {driver.protocols.length > 0 && <div><dt>Protocols</dt><dd>{driver.protocols.join(", ")}</dd></div>}
        {driver.capabilities.length > 0 && <div><dt>Capabilities</dt><dd>{driver.capabilities.join(", ")}</dd></div>}
        {driver.dependencies.length > 0 && <div><dt>Dependencies</dt><dd>{driver.dependencies.join(", ")}</dd></div>}
        {driver.documentationUrl && <div><dt>Documentation</dt><dd><a href={driver.documentationUrl} target="_blank" rel="noreferrer">{driver.documentationUrl.replace(/^https?:\/\//, "")}</a></dd></div>}
      </dl>

      {driver.updateAvailable && (
        <div className="update-avail" style={{ marginBottom: 10 }}>
          <strong>Update available</strong>
          <span className="muted"> · installed v{driver.installedVersion} → v{driver.version}</span>
        </div>
      )}

      {driver.releaseNotes && (
        <div className="drv-notes">
          <h4>Release notes</h4>
          <p className="muted">{driver.releaseNotes}</p>
        </div>
      )}

      {driver.changelog && driver.changelog.length > 0 && (
        <details className="drv-logs">
          <summary>Changelog ({driver.changelog.length})</summary>
          {driver.changelog.map((c) => (
            <div key={c.version} className="log">
              <span className="t">v{c.version} · {c.date}</span> {c.notes}
            </div>
          ))}
        </details>
      )}

      {/* Lifecycle actions */}
      <div className="drv-actions">
        {!driver.installed && has("install") && <button className="primary" disabled={busy} onClick={() => run(() => installDriverByKey(driver.key), "Installed")}>Install</button>}
        {driver.installed && (
          <>
            {driver.updateAvailable && <button className="primary" disabled={busy} onClick={() => run(() => updateDriverByKey(driver.key), "Updated")}>Update to v{driver.version}</button>}
            {has("enable") && <button disabled={busy} onClick={() => run(() => setDriverEnabled(id, !driver.enabled), driver.enabled ? "Disabled" : "Enabled")}>{driver.enabled ? "Disable" : "Enable"}</button>}
            {/* § Realtime State Architecture — the button click sets an immediate optimistic
                "connecting"/"disconnecting" (§10, instant feedback for the request itself),
                but "Connected"/"Disconnected" only ever comes from the real driverState
                event the backend publishes on confirmation (see liveStatusLabel/badge below
                and installer-context.ts's connectDriver()/disconnectDriver()) — never from
                this click handler alone. */}
            {isProtocol && has("connect") && <button disabled={busy} onClick={() => { applyDriverState(id, "connecting"); void run(() => connectDriver(id, true), "Connect requested"); }}>Connect</button>}
            {isProtocol && has("disconnect") && <button disabled={busy} onClick={() => { applyDriverState(id, "disconnecting"); void run(() => connectDriver(id, false), "Disconnect requested"); }}>Disconnect</button>}
            {has("uninstall") && <button className="danger" disabled={busy} onClick={() => run(() => uninstallDriver(id), "Uninstalled")}>Uninstall</button>}
          </>
        )}
      </div>

      {/* Schema-generated config page */}
      {driver.installed && schema.length > 0 && (
        <div className="drv-config">
          <h4>Configuration</h4>
          {driver.protocols.includes("knx") && (
            <KnxGatewayDiscoveryPanel
              // § live-confirmed fix — `gw.individualAddress` is the GATEWAY's own KNX
              // identity (what SEARCH_RESPONSE reports about the interface itself), never
              // a free address for a client to claim. Auto-filling "Physical address"
              // with it guarantees a collision the moment this hub tries to tunnel in —
              // live-confirmed on a real interface: the tunnel connection still reports
              // "connected", but the interface silently stops forwarding real bus
              // telegrams to a client sharing its own address, indistinguishable from
              // "nothing is on the bus" without a bus monitor to compare against. Host
              // and port genuinely describe the selected gateway, so those still apply;
              // the installer's own physical address (already typed, or left for them to
              // pick from the interface's own tunnelling address pool in ETS) is untouched.
              onSelect={(gw) => setValues((cur) => ({
                ...cur,
                host: gw.address,
                port: gw.port,
              }))}
            />
          )}
          {driver.protocols.includes("casambi") && String(values.connectionType ?? "cloud") === "cloud" && (
            <p className="help">
              The Casambi Cloud account (API key, network admin email/password) is configured
              once for this deployment and is never entered here — only which network this job's
              fixtures live in (below, optional).
            </p>
          )}
          {driver.protocols.includes("casambi") &&
            visibleCasambiConfigSchema(schema, values).map((f) => (
              <ConfigField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
            ))}
          {driver.protocols.includes("casambi") && String(values.connectionType ?? "cloud") === "local" && (
            <CasambiLocalGatewayPanel
              driverId={id}
              schema={schema}
              values={values}
              onChange={(key, v) => setValues((cur) => ({ ...cur, [key]: v }))}
            />
          )}
          {!driver.protocols.includes("casambi") &&
            schema.map((f) => (
              <ConfigField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
            ))}
          {driver.protocols.includes("casambi") && <CasambiAdvancedPlaceholders />}
          <button className="primary" disabled={busy} onClick={() => run(() => setDriverConfig(id, values), "Configuration saved")} style={{ marginTop: 10 }}>Save configuration</button>
        </div>
      )}

      {/* ETS import lives inside the Discovery Workspace itself (§ Unify ETS Import &
          Discovery Pipeline — "no special ETS UI"): an ETS export is just another signal
          source into the same Discover devices -> Review -> Approve workflow every other
          KNX onboarding method uses, not a separate panel/pipeline. */}
      {driver.installed && driver.protocols.includes("knx") && <KnxDiscoveryWorkspace />}

      {/* § Casambi Driver Refactor — Foundation: dedicated Diagnostics page (Connection Type,
          Gateway, Latency, Entities, Online/Offline, Reconnects, Last Event, REST/UDP Status,
          Health), driver-level rather than per-device. */}
      {driver.installed && driver.protocols.includes("casambi") && <CasambiDiagnosticsPanel driverId={id} />}

      {/* § Realtime State Architecture — the live connection-state badge, driven entirely
          by driverState WS events (falls back to nothing until the first one arrives;
          `health` below remains the separate, REST-only config/verdict snapshot). */}
      {isProtocol && driverStates[id]?.state && (
        <div className="drv-health">
          <span className={`drv-badge ${DRIVER_CONNECTION_LABEL[driverStates[id]!.state].cls}`}>
            {DRIVER_CONNECTION_LABEL[driverStates[id]!.state].text}
          </span>
          {driverStates[id]?.error && <span className="err"> · {driverStates[id]!.error}</span>}
        </div>
      )}

      {/* Health */}
      {health && (
        <div className="drv-health">
          <span className={`drv-badge ${health.verdict === "healthy" ? "ok" : health.verdict === "error" ? "err" : "off"}`}>{String(health.verdict)}</span>
          {health.configComplete === false && (() => {
            const missing = (health.missing as string[] | undefined) ?? [];
            // § Casambi fleet-wide env-var default — apiKey/email/password never render as fields
            // here (see CASAMBI_BACKEND_ONLY_KEYS), so telling an installer "apiKey is required"
            // points at a control that doesn't exist. Missing here means the deployment itself has
            // no SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD set — an admin-facing fact, not something
            // fixable from this screen.
            const casambiCredsMissing = driver.protocols.includes("casambi") && missing.some((m) => CASAMBI_BACKEND_ONLY_KEYS.has(m));
            const shown = missing.filter((m) => !CASAMBI_BACKEND_ONLY_KEYS.has(m));
            return (
              <span className="muted">
                {" · needs configuration"}
                {shown.length > 0 && ` (${shown.join(", ")})`}
                {casambiCredsMissing && " — this deployment has no Casambi Cloud account configured (SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD); contact your system administrator"}
              </span>
            );
          })()}
          {health.connected === true && <span className="muted"> · connected</span>}
          {typeof health.connectError === "string" && <span className="err"> · {health.connectError as string}</span>}
        </div>
      )}

      {/* Logs */}
      {driver.installed && logs.length > 0 && (
        <details className="drv-logs">
          <summary>Logs ({logs.length})</summary>
          {logs.slice(-15).reverse().map((l, idx) => (
            <div key={idx} className={`log ${l.level}`}>
              <span className="t">{new Date(l.ts).toLocaleTimeString()}</span> {l.message}
            </div>
          ))}
        </details>
      )}

      {msg && <p className="muted">{msg}</p>}
      {err && <p className="err">{err}</p>}
    </div>
  );
}

/**
 * KNX Gateway Auto Discovery (§ Driver Settings Experience): scans the LAN for KNX/IP
 * interfaces the moment this panel mounts (i.e. the instant the installer opens KNX
 * config), using the EXISTING `knxSearch()` backend via `discoverKnxGateways()` — no
 * discovery logic lives here, only the UI around it. One gateway found → selected
 * automatically. Multiple → a selectable list. None → manual entry is still right there
 * in the fields below, exactly as documented as the fallback path.
 */
function KnxGatewayDiscoveryPanel({ onSelect }: { onSelect: (gw: KnxGateway) => void }) {
  const [status, setStatus] = useState<"scanning" | "done" | "error">("scanning");
  const [gateways, setGateways] = useState<KnxGateway[]>([]);
  const [selectedAddress, setSelectedAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setStatus("scanning");
    setError(null);
    setSelectedAddress(null);
    try {
      const found = await discoverKnxGateways();
      setGateways(found);
      setStatus("done");
      if (found.length === 1) select(found[0]!);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Gateway discovery failed.");
      setStatus("error");
    }
  }

  useEffect(() => {
    void scan();
    // Scans once when the installer opens this driver's configuration — re-scan is a
    // deliberate action (the button below), not something that should silently re-fire
    // on every unrelated re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function select(gw: KnxGateway) {
    setSelectedAddress(gw.address);
    onSelect(gw);
  }

  return (
    <div className="drv-field" style={{ marginBottom: 14 }}>
      <span className="lbl">Gateway discovery</span>
      {status === "scanning" && <p className="muted" aria-busy="true">Scanning the network for KNX/IP gateways…</p>}
      {status === "error" && (
        <p className="err">
          {error} Enter the gateway details manually below, or{" "}
          <button type="button" className="link" onClick={() => void scan()}>try again</button>.
        </p>
      )}
      {status === "done" && gateways.length === 0 && (
        <p className="muted">
          No KNX/IP gateways found on this network.{" "}
          <button type="button" className="link" onClick={() => void scan()}>Scan again</button>, or enter the
          gateway details manually below.
        </p>
      )}
      {status === "done" && gateways.length > 0 && (
        <>
          <p className="muted">
            {gateways.length === 1 ? "1 gateway found and selected below." : `${gateways.length} gateways found — select one.`}
            {" "}<button type="button" className="link" onClick={() => void scan()}>Scan again</button>
          </p>
          <div className="knx-gw-list">
            {gateways.map((gw) => (
              <button
                type="button"
                key={gw.address}
                className={`knx-gw-item${selectedAddress === gw.address ? " selected" : ""}`}
                onClick={() => select(gw)}
              >
                <div className="knx-gw-name">{gw.name}</div>
                <div className="knx-gw-meta">
                  {gw.address}:{gw.port} · {gw.individualAddress}
                  {gw.tunnellingCapable === true && " · Tunnelling"}
                  {gw.routingCapable === true && " · Routing"}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ConfigField({ field, value, onChange }: { field: DriverConfigField; value: unknown; onChange: (v: unknown) => void }) {
  const common = { placeholder: field.placeholder };
  return (
    <label className="drv-field">
      <span className="lbl">{field.label}{field.required ? " *" : ""}</span>
      {field.type === "boolean" ? (
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)} />
      ) : field.type === "select" ? (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="">—</option>
          {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      ) : (
        <input
          type={field.type === "password" ? "password" : field.type === "number" || field.type === "port" ? "number" : "text"}
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value)}
          {...common}
        />
      )}
      {field.help && <span className="help">{field.help}</span>}
    </label>
  );
}

// ── Casambi Driver Refactor — Foundation: Driver Setup Wizard + Local Gateway settings ──────
const CASAMBI_CLOUD_ONLY_KEYS = new Set(["apiKey", "email", "password", "networkId"]);
// § Casambi fleet-wide env-var default — the Casambi Cloud ACCOUNT (API key, network admin
// email/password) is a deployment-wide credential (SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD, set
// once by whoever provisions the hub), never something an installer or homeowner types in — so
// these three never render as form fields, in either Cloud mode or Local Gateway's optional
// Cloud name-sync panel. `networkId` stays visible/editable: unlike the account credentials, it
// identifies which Casambi NETWORK this specific job's fixtures live in, which genuinely does
// vary per installation and has no deployment-wide default.
const CASAMBI_BACKEND_ONLY_KEYS = new Set(["apiKey", "email", "password"]);
const CASAMBI_LOCAL_ONLY_KEYS = new Set([
  "gatewayIp",
  "restPort",
  "gatewayUsername",
  "gatewayPassword",
  "udpPort",
  "netId",
  "dataFormat",
  "gatewayName",
  "autoDiscover",
]);

/**
 * Step 1 of the Casambi Setup Wizard is the `connectionType` field itself (always visible, first
 * in the manifest's config schema). Everything after it progressively discloses: picking Cloud
 * shows EXACTLY the pre-refactor Casambi fields, unchanged; picking Local Gateway shows the new
 * fields instead. Never both at once, never neither.
 */
export function visibleCasambiConfigSchema(schema: DriverConfigField[], values: Record<string, unknown>): DriverConfigField[] {
  const connectionType = String(values.connectionType ?? "cloud");
  return schema.filter((f) => {
    if (CASAMBI_BACKEND_ONLY_KEYS.has(f.key)) return false;
    if (CASAMBI_CLOUD_ONLY_KEYS.has(f.key)) return connectionType !== "local";
    if (CASAMBI_LOCAL_ONLY_KEYS.has(f.key)) return connectionType === "local";
    return true;
  });
}

/**
 * Renders the staged Test Connection result (§ UDP Diagnostics — "do not assume UDP behaves
 * like TCP"). REST reachability, HTTP authentication, and the UDP socket lifecycle are shown as
 * independent, honest facts rather than collapsed into one reachable/unreachable boolean — a
 * bound socket with zero packets received yet is shown as "Waiting for first event," never as a
 * failure, since Casambi's UDP protocol is connectionless and push-based.
 */
function CasambiTestConnectionReport({ res }: { res: CasambiTestConnectionResult }) {
  const restLabel = res.rest.reachable ? "✓ Connected" : "✗ Unreachable";
  const authLabel = res.rest.authFailed === null ? "—" : res.rest.authFailed ? "✗ Failed" : "✓ Success";
  const gatewayOnline = res.rest.reachable || res.udp.socketBound;
  const udpLabel = !res.udp.socketBound
    ? "✗ Bind failed"
    : !res.udp.packetSent
      ? "✗ Send failed"
      : res.udp.packetsReceived > 0
        ? "✓ Active"
        : "✓ Socket bound";
  const configLabel = res.udp.socketBound && res.udp.packetSent ? "✓ Verified" : "—";
  const status = !res.udp.socketBound
    ? "Socket error"
    : res.udp.packetsReceived > 0
      ? "Active"
      : "Waiting for first event";

  return (
    <div className="drv-config" style={{ marginTop: 8 }}>
      <dl className="drv-about">
        <div><dt>REST</dt><dd>{restLabel}</dd></div>
        <div><dt>HTTP Authentication</dt><dd>{authLabel}</dd></div>
        <div><dt>Gateway</dt><dd>{gatewayOnline ? "✓ Online" : "✗ Offline"}</dd></div>
        <div><dt>UDP</dt><dd>{udpLabel}</dd></div>
        <div><dt>Port</dt><dd>{res.udp.remotePort ?? "—"}</dd></div>
        <div><dt>Gateway configuration</dt><dd>{configLabel}</dd></div>
        <div><dt>Status</dt><dd>{status}</dd></div>
        <div><dt>Packets received</dt><dd>{res.udp.packetsReceived}</dd></div>
        <div><dt>Last packet</dt><dd>{res.udp.packetsReceived > 0 ? "Just now" : "Never"}</dd></div>
        <div><dt>Latency</dt><dd>{res.udp.averageLatencyMs === null ? "—" : `${res.udp.averageLatencyMs} ms`}</dd></div>
      </dl>
      <p className="help">
        "Gateway configuration ✓ Verified" means the entered IP/ports/Net ID/data format are well-formed and the
        test packet was accepted by the network stack — the Lithernet documentation does not describe a
        gateway-confirmed acknowledgement of these settings, so this is a local check, not a remote one.
      </p>
      <p className="muted">{res.message}</p>
    </div>
  );
}

/**
 * Local Gateway wizard actions. "Test Connection" is real and staged: a REST reachability + HTTP
 * auth check (using the Gateway Username/Password entered above, never Cloud credentials) and
 * the honest UDP socket lifecycle (created/bound/packet sent/notification received) against the
 * gateway address/ports/Net ID/data format entered above — never a write, so it can never
 * actuate a real device.
 *
 * § Discovery UX correction: this panel deliberately separates the TWO different discovery
 * mechanisms, which an earlier single "Auto Discover / not implemented" control wrongly conflated
 * into "discovery doesn't work":
 *
 *  - GATEWAY discovery (finding the Lithernet Gateway's IP) genuinely is NOT available — no
 *    discovery API, SSDP/mDNS profile, or enumeration endpoint is documented anywhere in the
 *    supplied Lithernet reference set. The IP must be entered manually. Implementing a speculative
 *    scan would be fabricating a protocol the vendor never defined.
 *  - DEVICE discovery (finding the Casambi units behind that gateway) IS implemented and fully
 *    automatic — `local-discovery.ts`'s `updateUnitFromControlValues` builds real units from
 *    incoming NotifyControlValues (opcode 0x4B) UDP notifications. It's progressive rather than
 *    instant (a unit appears as its first notification arrives, since no REST device-listing
 *    endpoint exists to enumerate from), but it requires no manual device creation at all.
 */
function CasambiLocalGatewayPanel({
  driverId,
  schema,
  values,
  onChange,
}: {
  driverId: string;
  schema: DriverConfigField[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const [busy, setBusy] = useState<"discover" | "test" | "sync" | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [result, setResult] = useState<CasambiTestConnectionResult | null>(null);
  const [syncResult, setSyncResult] = useState<CasambiNameSyncResult | null>(null);

  async function discover() {
    setBusy("discover");
    setNote(null);
    setResult(null);
    try {
      const res = await discoverCasambiLocalGateway();
      setNote(res.message);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Gateway discovery failed.");
    } finally {
      setBusy(null);
    }
  }

  async function test() {
    const gatewayIp = String(values.gatewayIp ?? "").trim();
    const restPort = Number(values.restPort);
    const udpPort = Number(values.udpPort);
    if (!gatewayIp || !Number.isFinite(restPort) || !Number.isFinite(udpPort)) {
      setNote("Enter Gateway IP, REST port, and UDP port above before testing.");
      return;
    }
    setBusy("test");
    setNote(null);
    setResult(null);
    try {
      const res = await testCasambiLocalConnection({
        gatewayIp,
        restPort,
        udpPort,
        netId: values.netId === undefined ? undefined : Number(values.netId),
        dataFormat: values.dataFormat === "dec-hash" ? "dec-hash" : "hex-dot",
        gatewayUsername: values.gatewayUsername === undefined ? undefined : String(values.gatewayUsername),
        gatewayPassword: values.gatewayPassword === undefined ? undefined : String(values.gatewayPassword),
      });
      setResult(res);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Test connection failed.");
    } finally {
      setBusy(null);
    }
  }

  async function syncNames() {
    setBusy("sync");
    setNote(null);
    setSyncResult(null);
    try {
      const res = await syncCasambiNamesFromCloud(driverId);
      setSyncResult(res);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Name sync failed.");
    } finally {
      setBusy(null);
    }
  }

  // Only networkId is ever shown here — apiKey/email/password are the deployment-wide Casambi
  // Cloud account (§ Casambi fleet-wide env-var default) and never render as a field, in Cloud
  // mode or here. Used ONLY for the one-time name sync below; never touches Local UDP, never
  // becomes a live connection.
  const cloudSyncFields = schema.filter((f) => f.key === "networkId");

  return (
    <div className="drv-field" style={{ marginBottom: 14 }}>
      <span className="lbl">Lithernet Gateway</span>
      <div className="drv-actions" style={{ marginTop: 0 }}>
        <button type="button" disabled={busy !== null} onClick={() => void discover()}>
          {busy === "discover" ? "Checking…" : "Check for Gateway Discovery"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void test()}>
          {busy === "test" ? "Testing…" : "Test Connection"}
        </button>
      </div>
      {note && <p className="muted">{note}</p>}
      {result && <CasambiTestConnectionReport res={result} />}
      {cloudSyncFields.length > 0 && (
        <div className="drv-config" style={{ marginTop: 14 }}>
          <span className="lbl">Cloud name sync (optional)</span>
          <p className="help">
            The Lithernet Gateway's own UDP/REST protocol has no field for a fixture's real name —
            checked against every locally-reachable interface (UDP, the full WebAPI, the web UI,
            .ceg export, the Diagnostics console). Nothing here changes how devices are discovered
            or controlled — that stays on Local UDP, unconditionally.
          </p>
          <p className="help">
            Uses this deployment's Casambi Cloud account — configured once, centrally, never
            entered here. Just pick which network this job's fixtures live in (optional; only
            needed if the account manages more than one), then click "Sync names from Cloud."
          </p>
          {cloudSyncFields.map((f) => (
            <ConfigField key={f.key} field={f} value={values[f.key]} onChange={(v) => onChange(f.key, v)} />
          ))}
          <p className="help">If you set a network id, click "Save configuration" below first — the sync reads the saved value, not what's typed above.</p>
          <div className="drv-actions" style={{ marginTop: 8 }}>
            <button type="button" disabled={busy !== null} onClick={() => void syncNames()}>
              {busy === "sync" ? "Syncing…" : "Sync names from Cloud"}
            </button>
          </div>
          {syncResult && (
            <p className="muted">
              Matched {syncResult.matched} of {syncResult.total} Cloud fixture{syncResult.total === 1 ? "" : "s"} to
              already-discovered devices{syncResult.networkName ? ` in "${syncResult.networkName}"` : ""}.
              {syncResult.matched < syncResult.total &&
                " A unit not yet discovered locally (no NotifyControlValues packet received yet) can't be named until it appears."}
            </p>
          )}
        </div>
      )}
      <CasambiDiscoveryExplainer />
    </div>
  );
}

/**
 * § Discovery UX correction — the two discovery mechanisms, stated separately and accurately.
 * Static explanatory copy (no fetch): both facts below are properties of the Lithernet protocol
 * and this driver's own implementation, not runtime state — the live "has discovery actually
 * started yet" view belongs in the Diagnostics panel (see `CasambiDiscoveryStatus`), not here.
 */
function CasambiDiscoveryExplainer() {
  return (
    <div className="drv-discovery-explainer">
      <div className="drv-discovery-item">
        <span className="drv-discovery-title">
          <StatusDot tone="warning" label="Not available" /> Automatic Gateway Discovery
        </span>
        <p className="help">
          Not available. The Lithernet Gateway documentation does not define any network discovery
          API — no REST enumeration endpoint and no SSDP/mDNS profile. Enter the Gateway IP
          manually above.
        </p>
      </div>
      <div className="drv-discovery-item">
        <span className="drv-discovery-title">
          <StatusDot tone="good" label="Enabled" /> Automatic Device Discovery
        </span>
        <p className="help">
          Enabled. Once the Gateway is connected, SupremeOS automatically discovers Casambi devices
          from incoming UDP notifications. No manual device creation is required. Units appear
          progressively, as each one's first notification arrives.
        </p>
      </div>
    </div>
  );
}

/** Advanced Settings placeholders (§ Driver Settings): Developer Mode and Packet Capture have
 * no real backing yet — shown visible but disabled with an honest label, never a
 * functional-looking control that silently does nothing. Logging IS real and ships as an
 * ordinary schema field (wired to the driver's own trace/onLog pipeline), so it is not repeated
 * here. */
function CasambiAdvancedPlaceholders() {
  return (
    <div className="drv-field" style={{ marginBottom: 14 }}>
      <span className="lbl">Advanced settings</span>
      <label className="drv-field" style={{ opacity: 0.6 }}>
        <span className="lbl">Developer mode</span>
        <input type="checkbox" disabled />
        <span className="help">Not implemented yet.</span>
      </label>
      <label className="drv-field" style={{ opacity: 0.6 }}>
        <span className="lbl">Packet capture</span>
        <input type="checkbox" disabled />
        <span className="help">Not implemented yet — the UDP engine now exists, but recording its traffic into the shared Packet Recorder framework hasn't been wired up.</span>
      </label>
    </div>
  );
}

const CASAMBI_STATUS_LABEL: Record<string, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  not_configured: "N/A",
  not_implemented: "Not implemented yet",
};
const CASAMBI_HEALTH_LABEL: Record<string, string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  error: "Error",
  not_implemented: "Not implemented yet",
};
const CASAMBI_UDP_STAGE_LABEL: Record<string, string> = {
  not_configured: "N/A",
  socket_error: "Socket error",
  bound_waiting: "Waiting for first event",
  active: "Active",
};

/** The dedicated Casambi Diagnostics page (§ Diagnostics; § UDP Diagnostics). Connection Type,
 * Gateway, Latency, Entities, Online/Offline Devices, Reconnect Count, Last Event, REST/UDP
 * Status, Health, plus — Local mode only — the real, staged UDP transport detail (socket state,
 * local/remote address:port, packet counters, probe latency, last error). A driver-level
 * snapshot, not per-device — `null` (driver not currently running) renders nothing, never a
 * fabricated all-zero shape. */
function CasambiDiagnosticsPanel({ driverId }: { driverId: string }) {
  const [snapshot, setSnapshot] = useState<CasambiDiagnostics | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchCasambiDiagnostics(driverId).then((s) => {
      if (!cancelled) setSnapshot(s);
    });
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  if (!snapshot) return null;
  const udp = snapshot.udp;
  return (
    <div className="drv-config">
      <h4>Diagnostics</h4>
      <dl className="drv-about">
        <div><dt>Connection type</dt><dd>{snapshot.connectionType === "local" ? "Local Gateway" : "Cloud"}</dd></div>
        <div><dt>Gateway</dt><dd>{snapshot.gateway ?? "—"}</dd></div>
        <div><dt>Latency</dt><dd>{snapshot.latencyMs === null ? "—" : `${snapshot.latencyMs} ms`}</dd></div>
        <div><dt>Entities</dt><dd>{snapshot.entities}</dd></div>
        <div><dt>Online devices</dt><dd>{snapshot.onlineDevices}</dd></div>
        <div><dt>Offline devices</dt><dd>{snapshot.offlineDevices}</dd></div>
        <div><dt>Reconnect count</dt><dd>{snapshot.reconnectCount}</dd></div>
        <div><dt>Last event</dt><dd>{snapshot.lastEventAt ? new Date(snapshot.lastEventAt).toLocaleString() : "—"}</dd></div>
        <div><dt>REST status</dt><dd>{CASAMBI_STATUS_LABEL[snapshot.restStatus] ?? snapshot.restStatus}</dd></div>
        <div><dt>UDP status</dt><dd>{CASAMBI_STATUS_LABEL[snapshot.udpStatus] ?? snapshot.udpStatus}</dd></div>
        <div><dt>Health</dt><dd><span className={`drv-badge ${snapshot.health === "healthy" ? "ok" : snapshot.health === "error" ? "err" : "off"}`}>{CASAMBI_HEALTH_LABEL[snapshot.health] ?? snapshot.health}</span></dd></div>
      </dl>
      {udp && (
        <>
          <h4>UDP transport</h4>
          <dl className="drv-about">
            <div><dt>Status</dt><dd>{CASAMBI_UDP_STAGE_LABEL[udp.stage] ?? udp.stage}</dd></div>
            <div><dt>Local address</dt><dd>{udp.localAddress ? `${udp.localAddress}:${udp.localPort}` : "—"}</dd></div>
            <div><dt>Remote gateway</dt><dd>{`${udp.remoteAddress}:${udp.remotePort}`}</dd></div>
            <div><dt>Packets sent</dt><dd>{udp.packetsSent}</dd></div>
            <div><dt>Packets received</dt><dd>{udp.packetsReceived}</dd></div>
            <div><dt>Last packet</dt><dd>{udp.lastPacketAt ? new Date(udp.lastPacketAt).toLocaleTimeString() : "Never"}</dd></div>
            <div><dt>Average latency</dt><dd>{udp.averageLatencyMs === null ? "—" : `${udp.averageLatencyMs} ms (probe round-trip)`}</dd></div>
            <div><dt>Packet loss</dt><dd>Not measurable — no sequence numbers in the documented protocol</dd></div>
            <div><dt>Last protocol error</dt><dd>{udp.lastDecodeError ? udp.lastDecodeError.message : udp.lastSendError ?? "None"}</dd></div>
          </dl>
          <CasambiPacketTraceTable traces={udp.recentTraces} />
        </>
      )}
      {snapshot.connectionType === "local" && <CasambiDiscoveryStatus snapshot={snapshot} />}
      {snapshot.connectionType === "local" && <CasambiReceivePipelineDashboard driverId={driverId} />}
    </div>
  );
}

/**
 * § Runtime Data Path Verification — the Runtime Pipeline Dashboard.
 *
 * Every stage is rendered INDEPENDENTLY, with its own entered/exited/failures counters, first/last
 * timestamps and latency. Deliberately no aggregate "pipeline health" number: an aggregate is
 * exactly what hid this failure for so long — a single green tick over a pipeline whose third
 * stage has been at zero the whole time.
 *
 * Two display rules carry the honesty requirement into the UI itself:
 *  - A `null` metric renders as "not measured" with its reason on hover, NEVER as `0`. "Zero
 *    packets entered" and "nothing counts what enters here" lead to opposite conclusions.
 *  - A `waiting` stage is neutral, not a warning. On a freshly-connected gateway, waiting is the
 *    correct state, and colouring it red teaches installers to ignore red.
 *
 * This is a diagnostics-only surface: it adds no control, changes no protocol behavior, and is not
 * rendered at all in Cloud mode (which has no UDP receive pipeline).
 */
function CasambiReceivePipelineDashboard({ driverId }: { driverId: string }) {
  const [report, setReport] = useState<ReceiveCertification | null>(null);
  const [loading, setLoading] = useState(false);
  const [wiresharkPackets, setWiresharkPackets] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const parsed = Number(wiresharkPackets);
    const withCapture = wiresharkPackets.trim() !== "" && Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    setReport(await fetchCasambiReceivePipeline(driverId, withCapture));
    setLoading(false);
  }, [driverId, wiresharkPackets]);

  return (
    <>
      <h4>Receive pipeline</h4>
      <p className="help">
        Every stage from the OS network stack to room assignment, measured independently. Run this
        when packets are being sent but nothing arrives — it localizes exactly where they stop.
      </p>
      <div className="drv-pipeline-controls">
        <label htmlFor="ws-packets">
          Host capture packet count (optional)
          <input
            id="ws-packets"
            type="number"
            min={0}
            inputMode="numeric"
            placeholder="e.g. 145"
            value={wiresharkPackets}
            onChange={(e) => setWiresharkPackets(e.target.value)}
          />
        </label>
        <Button onClick={() => void load()} aria-busy={loading}>
          {report ? "Refresh" : "Run verification"}
        </Button>
      </div>
      <p className="help">
        From <code>tcpdump -i &lt;iface&gt; udp port 10009</code> or Wireshark on the hub host, over
        the same window. SupremeOS cannot observe this itself — supplying it is what separates
        &ldquo;the gateway is not transmitting&rdquo; from &ldquo;the packets never reach this
        process&rdquo;, which otherwise produce identical counters.
      </p>

      {report && (
        <>
          {report.lanQueryError && (
            <p className="help">
              <StatusDot tone="warning" label="Transport forensics unavailable" /> supreme-lan did not
              answer the forensics request ({report.lanQueryError}). Network-layer stages below are
              reported as un-inspected rather than assumed healthy.
            </p>
          )}
          <div style={{ overflowX: "auto" }}>
            <table className="drv-trace-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Status</th>
                  <th>Entered</th>
                  <th>Exited</th>
                  <th>Failures</th>
                  <th>Latency</th>
                  <th>Last</th>
                </tr>
              </thead>
              <tbody>
                {report.stages.map((stage) => (
                  <tr key={stage.name}>
                    <td style={{ whiteSpace: "normal" }}>
                      {stage.name}
                      {stage.detail && <div className="drv-stage-detail">{stage.detail}</div>}
                    </td>
                    <td>
                      <StatusDot
                        tone={stage.status === "pass" ? "good" : stage.status === "fail" ? "critical" : "neutral"}
                        label={stage.status === "pass" ? "Pass" : stage.status === "fail" ? "Fail" : "Waiting"}
                      />
                    </td>
                    <td><StageMetricCell value={stage.metrics?.entered ?? null} reason={stage.metrics?.unmeasured ?? null} /></td>
                    <td><StageMetricCell value={stage.metrics?.exited ?? null} reason={stage.metrics?.unmeasured ?? null} /></td>
                    <td><StageMetricCell value={stage.metrics?.failures ?? null} reason={stage.metrics?.unmeasured ?? null} /></td>
                    <td><StageMetricCell value={stage.metrics?.latencyMs ?? null} reason={stage.metrics?.unmeasured ?? null} suffix=" ms" /></td>
                    <td>{stage.metrics?.lastAt ? new Date(stage.metrics.lastAt).toLocaleTimeString() : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>Root cause</h4>
          <dl className="drv-about">
            <div>
              <dt>Verdict</dt>
              <dd>
                <StatusDot
                  tone={report.rootCause.cause === "packets_received_by_socket" ? "good" : report.rootCause.cause === "unknown" ? "neutral" : "critical"}
                  label={report.rootCause.cause}
                />{" "}
                {report.rootCause.cause.replace(/_/g, " ")}
              </dd>
            </div>
            <div><dt>Summary</dt><dd style={{ whiteSpace: "normal" }}>{report.rootCause.summary}</dd></div>
            {report.rootCause.needed && (
              <div><dt>Needed to resolve</dt><dd style={{ whiteSpace: "normal" }}>{report.rootCause.needed}</dd></div>
            )}
            <div>
              <dt>Evidence</dt>
              <dd style={{ whiteSpace: "normal" }}>
                {report.rootCause.evidence.length === 0 ? "—" : <ul className="drv-evidence">{report.rootCause.evidence.map((e) => <li key={e}><code>{e}</code></li>)}</ul>}
              </dd>
            </div>
          </dl>

          <h4>Host capture comparison</h4>
          <dl className="drv-about">
            <div><dt>Host capture packets</dt><dd>{report.wireshark.wiresharkPackets ?? "Not supplied"}</dd></div>
            <div><dt>supreme-lan socket packets</dt><dd>{report.wireshark.socketPackets ?? "Unknown"}</dd></div>
            <div><dt>Difference</dt><dd>{report.wireshark.difference ?? "Not determinable"}</dd></div>
            <div><dt>Stage where packets disappear</dt><dd style={{ whiteSpace: "normal" }}>{report.wireshark.stageWherePacketsDisappear}</dd></div>
          </dl>

          <h4>Certification</h4>
          <dl className="drv-about">
            {report.sections.map((s) => (
              <div key={s.name}>
                <dt>{s.name}</dt>
                <dd style={{ whiteSpace: "normal" }}>
                  <StatusDot
                    tone={s.status === "pass" ? "good" : s.status === "fail" ? "critical" : "neutral"}
                    label={s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "NOT EVALUATED"}
                  />{" "}
                  {s.status === "pass" ? "PASS" : s.status === "fail" ? "FAIL" : "NOT EVALUATED"} — {s.detail}
                </dd>
              </div>
            ))}
          </dl>
          {!report.certified && (
            <p className="help">
              Not certified. A section that was never exercised counts as un-run, not as passing —
              certification requires every one of the seven sections to be evaluated and passing.
            </p>
          )}
        </>
      )}
    </>
  );
}

/** Renders a stage metric, keeping "not measured" visually distinct from a real `0`. The reason a
 * value is absent is carried in the title so it is available without cluttering the table. */
function StageMetricCell({ value, reason, suffix = "" }: { value: number | null; reason: string | null; suffix?: string }) {
  if (value === null) {
    return (
      <span className="muted" title={reason ?? "Not measured at this stage."}>
        n/m
      </span>
    );
  }
  return <>{value}{suffix}</>;
}

/**
 * § Discovery UX correction — live DEVICE discovery status, Local mode only.
 *
 * Device discovery is implemented and automatic; it is simply *driven by incoming UDP traffic*,
 * so before the first notification arrives there is genuinely nothing discovered yet. This panel
 * has to say that precisely: "waiting for the first notification" is a normal, expected state on
 * a freshly-connected gateway, NOT evidence that discovery is unsupported (which is exactly the
 * wrong conclusion the old wording invited). Every number below is real snapshot state — nothing
 * is estimated, and no "expected device count" is invented, because the Local protocol provides
 * no device-listing endpoint to compare against.
 */
function CasambiDiscoveryStatus({ snapshot }: { snapshot: CasambiDiagnostics }) {
  const udp = snapshot.udp;
  const received = udp?.packetsReceived ?? 0;
  const running = received > 0;
  return (
    <>
      <h4>Device discovery</h4>
      <dl className="drv-about">
        <div>
          <dt>Status</dt>
          <dd>
            {/* "neutral", not "warning": waiting for the first notification on a freshly-connected
                gateway is a normal expected state, not a fault. */}
            <StatusDot tone={running ? "good" : "neutral"} label={running ? "Running" : "Waiting"} />{" "}
            {running ? "Running" : "Waiting for first UDP notification"}
          </dd>
        </div>
        <div><dt>Notifications received</dt><dd>{received}</dd></div>
        <div><dt>Devices discovered</dt><dd>{snapshot.entities}</dd></div>
        <div><dt>Entities created</dt><dd>{snapshot.entities}</dd></div>
        <div><dt>Last discovery event</dt><dd>{snapshot.lastEventAt ? new Date(snapshot.lastEventAt).toLocaleTimeString() : "—"}</dd></div>
      </dl>
      {!running && (
        <p className="help">
          Waiting for first UDP notification. Device discovery will begin automatically after the
          first Casambi event is received — no manual device creation is required. If this stays at
          zero, the problem is the UDP path (see UDP transport above), not device discovery itself.
        </p>
      )}
      {/* Rooms are assigned by the shared Room Assignment Engine at commissioning time, from the
          discovery queue's room hint — not by this driver, and the Local UDP protocol carries no
          room/group name of its own to derive one from. Stating a "rooms assigned" count here
          would imply this driver does something it doesn't. */}
      <p className="help">
        Room assignment happens at commissioning, via the shared Room Assignment Engine — the
        Casambi Local UDP protocol carries no room or group names, so rooms cannot be derived from
        gateway traffic alone.
      </p>
    </>
  );
}

/**
 * Real protocol trace table (§ UDP Receive Pipeline Audit, Step 6) — every datagram the socket
 * actually received, parsed or not, so an installer/engineer can cross-check this against a
 * Wireshark capture directly. A packet that failed to parse still appears here with its raw
 * payload and the exact parser error, never silently dropped.
 */
function CasambiPacketTraceTable({ traces }: { traces: CasambiUdpPacketTrace[] }) {
  if (traces.length === 0) {
    return <p className="muted">No UDP packets received yet.</p>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="drv-trace-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Source</th>
            <th>Bytes</th>
            <th>Raw ASCII</th>
            <th>Decoded</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {[...traces].reverse().map((t, i) => (
            <tr key={`${t.at}-${i}`}>
              <td>{new Date(t.at).toLocaleTimeString()}</td>
              <td>{`${t.sourceAddress}:${t.sourcePort}`}</td>
              <td>{t.payloadLength}</td>
              <td title={t.rawHex}>{t.rawAscii.trim()}</td>
              <td>{t.decoded ? `opcode 0x${t.decoded.opcode.toString(16)}` : "—"}</td>
              <td>{t.parseError ? <span className="drv-badge err">{t.parseError}</span> : <span className="drv-badge ok">OK</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
