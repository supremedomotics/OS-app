import { useEffect, useState } from "react";
import {
  connectDriver,
  discoverKnxGateways,
  type DriverConfigField,
  type DriverEntry,
  fetchDriverHealth,
  fetchDriverLogs,
  fetchDriverRegistry,
  getDriverConfig,
  importKnx,
  importKnxProject,
  installDriverByKey,
  type KnxGateway,
  type KnxImportResult,
  setDriverConfig,
  setDriverEnabled,
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

export function statusLabel(d: DriverEntry): { text: string; cls: string } {
  if (!d.installed) return { text: "Not installed", cls: "off" };
  if (!d.enabled) return { text: "Disabled", cls: "off" };
  if (d.status === "error") return { text: "Error", cls: "err" };
  return { text: "Active", cls: "ok" };
}

function DriverRow({ driver, expanded, onToggle, onChanged }: { driver: DriverEntry; expanded: boolean; onToggle: () => void; onChanged: () => void }) {
  const s = statusLabel(driver);
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
  const [health, setHealth] = useState<Record<string, unknown> | null>(null);
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
          {schema.map((f) => (
            <ConfigField key={f.key} field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} />
          ))}
          <button className="primary" disabled={busy} onClick={() => run(() => setDriverConfig(id, values), "Configuration saved")} style={{ marginTop: 10 }}>Save configuration</button>
        </div>
      )}

      {/* KNX ETS project import — the answer to "where do I add my group addresses" once the
          bus is connected. Protocol-specific (KNX only), so it's a direct addition here rather
          than a generic schema field. */}
      {driver.installed && driver.protocols.includes("knx") && <KnxImportPanel />}
      {driver.installed && driver.protocols.includes("knx") && <KnxDiscoveryWorkspace />}

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

/**
 * KNX ETS project import (§4): upload a `.knxproj` (device cards placed in their ETS rooms) or
 * paste an ETS group-address export (CSV/XML — capabilities inferred from each datapoint type).
 * Lives directly on the connected KNX extension's own page, so "where do I bring in my group
 * addresses" has one obvious answer instead of a separate hidden screen.
 */
function KnxImportPanel() {
  const [text, setText] = useState("");
  const [knxproj, setKnxproj] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function report(out: KnxImportResult) {
    setResult(`Imported ${out.devices} device${out.devices === 1 ? "" : "s"}${out.roomsCreated ? ` · ${out.roomsCreated} new room${out.roomsCreated === 1 ? "" : "s"}` : ""}.`);
    setText("");
    setKnxproj(null);
    setPassword("");
    setNeedsPassword(false);
  }

  async function runImport(fn: () => Promise<KnxImportResult>) {
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      report(await fn());
    } catch (e) {
      const message = e instanceof Error ? e.message : "Import failed.";
      if (/password/i.test(message)) setNeedsPassword(true);
      setErr(message);
    } finally {
      setBusy(false);
    }
  }

  async function onFile(file: File) {
    setNeedsPassword(false);
    setPassword("");
    if (file.name.toLowerCase().endsWith(".knxproj")) {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
      const base64 = btoa(bin);
      setKnxproj(base64);
      await runImport(() => importKnxProject(base64));
    } else {
      setText(await file.text());
      setResult(null);
      setErr(null);
    }
  }

  return (
    <div className="drv-config">
      <h4>Import ETS project</h4>
      <p className="muted">
        Upload a <code>.knxproj</code> (device cards placed in their ETS rooms), or paste an ETS
        group-address export (CSV/XML). Capabilities are inferred from each datapoint type.
      </p>
      <input
        type="file"
        accept=".knxproj,.csv,.xml,text/xml,text/csv"
        disabled={busy}
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFile(f); e.target.value = ""; }}
        style={{ marginBottom: 10 }}
      />
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder='e.g. <GroupAddress Name="Living Room - Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />'
        rows={5}
        style={{ width: "100%", fontFamily: "monospace", fontSize: 12 }}
      />
      {needsPassword && knxproj && (
        <label className="drv-field" style={{ marginTop: 8 }}>
          <span className="lbl">Project password</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="ETS project password" />
        </label>
      )}
      <div className="drv-actions" style={{ marginTop: 8 }}>
        {needsPassword && knxproj ? (
          <button className="primary" disabled={busy || !password} onClick={() => runImport(() => importKnxProject(knxproj, password))}>
            {busy ? "Importing…" : "Import with password"}
          </button>
        ) : (
          <button className="primary" disabled={busy || !text.trim()} onClick={() => runImport(() => importKnx(text))}>
            {busy ? "Importing…" : "Import group addresses"}
          </button>
        )}
      </div>
      {result && <p className="muted">{result}</p>}
      {err && <p className="err">{err}</p>}
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
