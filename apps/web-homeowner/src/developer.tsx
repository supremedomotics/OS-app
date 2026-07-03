import { useEffect, useRef, useState } from "react";
import { apiRequest, fetchLicense, streamUrl } from "./api.js";

/**
 * Developer Edition tools (§Developer Mode). This whole section is HIDDEN unless the hub is in
 * Developer Mode. It exposes only the engineering tools that are actually functional today — an API
 * explorer, a live WebSocket inspector, and hub diagnostics. Protocol analyzers (KNX telegram / DALI
 * / Zigbee mesh / Matter fabric / BLE), the DB browser, file manager, OTA/firmware managers etc. are
 * deliberately NOT shown until they're real, per the "no placeholder pages" rule.
 */
export function DeveloperTools() {
  const [devMode, setDevMode] = useState(false);
  const [tool, setTool] = useState<"api" | "ws" | "diag">("api");

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
      </div>
      {tool === "api" && <ApiExplorer />}
      {tool === "ws" && <WsInspector />}
      {tool === "diag" && <Diagnostics />}
    </section>
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
