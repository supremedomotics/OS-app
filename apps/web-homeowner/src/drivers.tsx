import { useEffect, useState } from "react";
import {
  type CasambiDiagnostics,
  connectDriver,
  discoverCasambiLocalGateway,
  discoverKnxGateways,
  type DriverConfigField,
  type DriverEntry,
  type DriverHealth,
  fetchCasambiDiagnostics,
  fetchDriverHealth,
  fetchDriverLogs,
  fetchDriverRegistry,
  getDriverConfig,
  installDriverByKey,
  type KnxGateway,
  setDriverConfig,
  setDriverEnabled,
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

function DriverRow({ driver, expanded, onToggle, onChanged }: { driver: DriverEntry; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  // Real connection state, not just install/enable — see `statusLabel`'s doc comment.
  // Only fetched for drivers where it's meaningful (installed + enabled); "Not
  // installed"/"Disabled" is already the honest, complete answer without a health call.
  const [connected, setConnected] = useState<boolean | null | undefined>(undefined);
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
  const s = statusLabel(driver, connected);
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
            {isProtocol && has("connect") && <button disabled={busy} onClick={() => run(() => connectDriver(id, true), "Connect requested")}>Connect</button>}
            {isProtocol && has("disconnect") && <button disabled={busy} onClick={() => run(() => connectDriver(id, false), "Disconnect requested")}>Disconnect</button>}
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
              onSelect={(gw) => setValues((cur) => ({
                ...cur,
                host: gw.address,
                port: gw.port,
                individualAddress: gw.individualAddress,
              }))}
            />
          )}
          {driver.protocols.includes("casambi") &&
            visibleCasambiConfigSchema(schema, values).map((f) => (
              <ConfigField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
            ))}
          {driver.protocols.includes("casambi") && String(values.connectionType ?? "cloud") === "local" && (
            <CasambiLocalGatewayPanel values={values} />
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

      {/* Health */}
      {health && (
        <div className="drv-health">
          <span className={`drv-badge ${health.verdict === "healthy" ? "ok" : health.verdict === "error" ? "err" : "off"}`}>{String(health.verdict)}</span>
          {health.configComplete === false && <span className="muted"> · needs configuration ({(health.missing as string[] | undefined)?.join(", ")})</span>}
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
const CASAMBI_LOCAL_ONLY_KEYS = new Set(["gatewayIp", "restPort", "udpPort", "netId", "dataFormat", "gatewayName", "autoDiscover"]);

/**
 * Step 1 of the Casambi Setup Wizard is the `connectionType` field itself (always visible, first
 * in the manifest's config schema). Everything after it progressively discloses: picking Cloud
 * shows EXACTLY the pre-refactor Casambi fields, unchanged; picking Local Gateway shows the new
 * fields instead. Never both at once, never neither.
 */
function visibleCasambiConfigSchema(schema: DriverConfigField[], values: Record<string, unknown>): DriverConfigField[] {
  const connectionType = String(values.connectionType ?? "cloud");
  return schema.filter((f) => {
    if (CASAMBI_CLOUD_ONLY_KEYS.has(f.key)) return connectionType !== "local";
    if (CASAMBI_LOCAL_ONLY_KEYS.has(f.key)) return connectionType === "local";
    return true;
  });
}

/**
 * Local Gateway wizard actions. "Test Connection" is real (a REST reachability check + a safe
 * UDP 0x39 "own node" probe against the gateway address/ports/Net ID/data format entered above —
 * never a write, so it can never actuate a real device). "Auto Discover" honestly reports
 * "not implemented" — no gateway enumeration/discovery endpoint is documented for the Lithernet
 * Gateway, never a fabricated success.
 */
function CasambiLocalGatewayPanel({ values }: { values: Record<string, unknown> }) {
  const [busy, setBusy] = useState<"discover" | "test" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function discover() {
    setBusy("discover");
    setNote(null);
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
    try {
      const res = await testCasambiLocalConnection({
        gatewayIp,
        restPort,
        udpPort,
        netId: values.netId === undefined ? undefined : Number(values.netId),
        dataFormat: values.dataFormat === "dec-hash" ? "dec-hash" : "hex-dot",
      });
      setNote(`${res.message} (REST: ${res.rest ? "reachable" : "unreachable"}, UDP: ${res.udp ? "reachable" : "unreachable"})`);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Test connection failed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="drv-field" style={{ marginBottom: 14 }}>
      <span className="lbl">Lithernet Gateway</span>
      <div className="drv-actions" style={{ marginTop: 0 }}>
        <button type="button" disabled={busy !== null} onClick={() => void discover()}>
          {busy === "discover" ? "Scanning…" : "Auto Discover"}
        </button>
        <button type="button" disabled={busy !== null} onClick={() => void test()}>
          {busy === "test" ? "Testing…" : "Test Connection"}
        </button>
      </div>
      {note && <p className="muted">{note}</p>}
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

/** The dedicated Casambi Diagnostics page (§ Diagnostics): Connection Type, Gateway, Latency,
 * Entities, Online/Offline Devices, Reconnect Count, Last Event, REST/UDP Status, Health. A
 * driver-level snapshot, not per-device — `null` (driver not currently running) renders nothing,
 * never a fabricated all-zero shape. */
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
    </div>
  );
}
