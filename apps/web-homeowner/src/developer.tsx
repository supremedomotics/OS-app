import { useEffect, useRef, useState } from "react";
import { apiRequest, fetchAudit, fetchLicense, streamUrl, verifyAudit, type AuditEntry } from "./api.js";

/**
 * Developer Edition tools (§Developer Mode). This whole section is HIDDEN unless the hub is in
 * Developer Mode. It exposes only the engineering tools that are actually functional today — an API
 * explorer, a live WebSocket inspector, and hub diagnostics. Protocol analyzers (KNX telegram / DALI
 * / Zigbee mesh / Matter fabric / BLE), the DB browser, file manager, OTA/firmware managers etc. are
 * deliberately NOT shown until they're real, per the "no placeholder pages" rule.
 */
export function DeveloperTools() {
  const [devMode, setDevMode] = useState(false);
  const [tool, setTool] = useState<"api" | "ws" | "diag" | "audit" | "drivers">("api");

  useEffect(() => {
    void fetchLicense().then((l) => setDevMode(Boolean(l?.service?.devMode)));
  }, []);

  if (!devMode) return null;

  return (
    <section className="card-section dev-section">
      <h2 className="section-title">⚙ Developer tools</h2>
      <p className="sub">Engineering tools — visible only in Developer Mode.</p>
      <div className="seg" style={{ marginBottom: 12 }}>
        <button className={tool === "api" ? "on" : ""} onClick={() => setTool("api")}>API Explorer</button>
        <button className={tool === "ws" ? "on" : ""} onClick={() => setTool("ws")}>WebSocket</button>
        <button className={tool === "diag" ? "on" : ""} onClick={() => setTool("diag")}>Diagnostics</button>
        <button className={tool === "drivers" ? "on" : ""} onClick={() => setTool("drivers")}>Driver Lifecycle</button>
        <button className={tool === "audit" ? "on" : ""} onClick={() => setTool("audit")}>Audit log</button>
      </div>
      {tool === "api" && <ApiExplorer />}
      {tool === "ws" && <WsInspector />}
      {tool === "diag" && <Diagnostics />}
      {tool === "drivers" && <DriverLifecyclePanel />}
      {tool === "audit" && <AuditLog />}
    </section>
  );
}

interface DriverLifecycleStatusView {
  protocol: string; key: string; stage: string; healthy: boolean; lastError: string | null;
  bindingCount: number; boundCount: number; ownedCount: number; reconnects: number; updatedAt: string;
}
interface DriverDiagnosticsEntryView {
  key: string; name: string; installed: boolean; enabled: boolean;
  protocols: DriverLifecycleStatusView[]; healthy: boolean; lastError: string | null;
}

/** Driver Diagnostics (§ Diagnostics): every native driver's full lifecycle picture —
 * registration stage, ownership/binding counts, health, last error, reconnects — so
 * troubleshooting "why isn't this device responding" never requires reading logs. */
function DriverLifecyclePanel() {
  const [drivers, setDrivers] = useState<DriverDiagnosticsEntryView[]>([]);
  const [providers, setProviders] = useState<Record<string, number> | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    const res = await apiRequest("GET", "/v1/drivers/diagnostics");
    if (res.status === 200) {
      const body = res.body as { drivers: DriverDiagnosticsEntryView[]; providers: Record<string, number> };
      setDrivers(body.drivers);
      setProviders(body.providers);
    }
    setBusy(false);
  }
  useEffect(() => { void load(); }, []);

  return (
    <div className="dev-drivers">
      <div className="dev-row2" style={{ marginBottom: 8 }}>
        <button disabled={busy} onClick={load}>{busy ? "Loading…" : "Refresh"}</button>
        {providers && (
          <span className="muted">
            Lifecycle — unbound {providers.UNBOUND} · binding {providers.BINDING} · bound {providers.BOUND} · online {providers.ONLINE} · offline {providers.OFFLINE} · error {providers.ERROR}
          </span>
        )}
      </div>
      {drivers.filter((d) => d.protocols.length > 0).length === 0 && <p className="muted">No native protocol drivers have registered yet.</p>}
      {drivers.filter((d) => d.protocols.length > 0).map((d) => (
        <div key={d.key} className="audit-list" style={{ marginBottom: 10 }}>
          <div className="dev-row2">
            <strong>{d.name}</strong>
            <span className={d.healthy ? "muted" : "err"}>{d.healthy ? "✓ healthy" : "✕ unhealthy"}</span>
          </div>
          {d.protocols.map((p) => (
            <div key={p.protocol} style={{ fontSize: 13, marginTop: 4 }}>
              <div><code>{p.protocol}</code> — stage: <b>{p.stage}</b>{p.reconnects > 0 ? ` · ${p.reconnects} reconnect(s)` : ""}</div>
              <div className="muted">bindings {p.boundCount}/{p.bindingCount} restored · {p.ownedCount} device(s) owned · updated {new Date(p.updatedAt).toLocaleTimeString()}</div>
              {p.lastError && <div className="err">last error: {p.lastError}</div>}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Read-only tamper-evident audit log (admin). Shows the hash-chained activity trail + verify. */
function AuditLog() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [verify, setVerify] = useState<{ valid: boolean; brokenAt?: number } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setBusy(true);
    const r = await fetchAudit();
    setEntries(r.entries);
    setError(r.error ?? null);
    setBusy(false);
  }
  useEffect(() => { void load(); }, []);

  const fmt = (s: string) => s.replace(/[._]/g, " ");
  return (
    <div className="audit">
      <div className="dev-row2" style={{ marginBottom: 8 }}>
        <button disabled={busy} onClick={load}>{busy ? "Loading…" : "Refresh"}</button>
        <button disabled={busy} onClick={async () => setVerify(await verifyAudit())}>Verify chain</button>
        {verify && (
          <span className={verify.valid ? "muted" : "err"}>
            {verify.valid ? "✓ Chain intact" : `✕ Broken at #${verify.brokenAt ?? "?"}`}
          </span>
        )}
      </div>
      {error && <p className="err">{error}</p>}
      {!error && entries.length === 0 && <p className="muted">No audit entries yet.</p>}
      {entries.length > 0 && (
        <div className="audit-list">
          {entries.map((e) => (
            <div className="audit-row" key={e.id}>
              <span className="audit-seq">#{e.seq}</span>
              <div className="audit-body">
                <span className="audit-action">{fmt(e.action)}</span>
                <span className="audit-meta">
                  {e.resourceType}{e.resourceId ? ` · ${e.resourceId.slice(0, 10)}…` : ""} · {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApiExplorer() {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/v1/home");
  const [body, setBody] = useState("");
  const [result, setResult] = useState<{ status: number; body: unknown } | null>(null);
  const [busy, setBusy] = useState(false);

  async function send() {
    setBusy(true);
    try {
      setResult(await apiRequest(method, path, body || undefined));
    } catch (e) {
      setResult({ status: 0, body: e instanceof Error ? e.message : "request failed" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="dev-tool">
      <div className="dev-row2">
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          {["GET", "POST", "PUT", "PATCH", "DELETE"].map((m) => <option key={m}>{m}</option>)}
        </select>
        <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/v1/..." />
        <button className="primary" disabled={busy} onClick={send}>Send</button>
      </div>
      {method !== "GET" && <textarea value={body} onChange={(e) => setBody(e.target.value)} placeholder='{ "json": "body" }' rows={4} />}
      {result && (
        <>
          <p className={`muted dev-status ${result.status >= 200 && result.status < 300 ? "ok" : "err"}`}>HTTP {result.status}</p>
          <pre className="dev-out">{JSON.stringify(result.body, null, 2)}</pre>
        </>
      )}
    </div>
  );
}

function WsInspector() {
  const [frames, setFrames] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  function connect() {
    const url = streamUrl();
    if (!url) return;
    const ws = new WebSocket(url);
    wsRef.current = ws;
    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "subscribe", rooms: ["*"] }));
      setFrames((f) => ["→ subscribe *", ...f]);
    };
    ws.onmessage = (e) => setFrames((f) => [String(e.data).slice(0, 400), ...f].slice(0, 200));
    ws.onclose = () => setConnected(false);
    ws.onerror = () => setFrames((f) => ["⚠ socket error", ...f]);
  }
  function disconnect() {
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
  }
  useEffect(() => () => wsRef.current?.close(), []);

  return (
    <div className="dev-tool">
      <div className="dev-row2">
        {!connected ? <button className="primary" onClick={connect}>Connect</button> : <button onClick={disconnect}>Disconnect</button>}
        <span className="muted">{connected ? "live" : "disconnected"} · {frames.length} frames</span>
      </div>
      <pre className="dev-out dev-ws">{frames.join("\n")}</pre>
    </div>
  );
}

function Diagnostics() {
  const [diag, setDiag] = useState<unknown>(null);
  useEffect(() => {
    void apiRequest("GET", "/v1/diagnostics").then((r) => setDiag(r.body));
  }, []);
  return <pre className="dev-out">{diag ? JSON.stringify(diag, null, 2) : "Loading…"}</pre>;
}
