import { useEffect, useState } from "react";
import { commissionUnifiProtectCameras, listUnifiProtectCameras, type UnifiProtectCamera, type UnifiProtectCommissionResult } from "./api";

/**
 * § UniFi Protect mode (RTSP Camera Extension) — lists a UniFi console's cameras and commissions
 * the selected ones. The API key lives only in this component's state and is sent per request; the
 * hub never stores it. Reached from the RTSP Camera Discover panel, which pre-fills the console
 * address when discovery detected one (ports 7441/7447).
 */
export function UnifiProtectSection({ detectedHost, onDone }: { detectedHost: string | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [cameras, setCameras] = useState<UnifiProtectCamera[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, UnifiProtectCommissionResult>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (detectedHost) {
      setHost((h) => h || detectedHost);
      setOpen(true);
    }
  }, [detectedHost]);

  if (!open) {
    return (
      <p className="muted" style={{ marginTop: 10 }}>
        <button type="button" className="link" onClick={() => setOpen(true)}>Add cameras from a UniFi Protect console</button>
      </p>
    );
  }

  async function find() {
    setBusy(true);
    setErr(null);
    setResults({});
    try {
      const list = await listUnifiProtectCameras(host.trim(), apiKey);
      setCameras(list);
      setSelected(new Set(list.map((c) => c.id)));
    } catch (e) {
      setCameras(null);
      setErr(e instanceof Error ? e.message : "Could not list cameras from the UniFi console.");
    } finally {
      setBusy(false);
    }
  }

  async function addSelected() {
    if (!cameras) return;
    setBusy(true);
    setErr(null);
    try {
      const picked = cameras.filter((c) => selected.has(c.id));
      const out = await commissionUnifiProtectCameras(host.trim(), apiKey, picked.map((c) => ({ id: c.id, name: c.name, model: c.model })));
      setResults(Object.fromEntries(out.map((r) => [r.unifiCameraId, r])));
      if (out.some((r) => r.status === "added")) onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add the selected cameras.");
    } finally {
      setBusy(false);
    }
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
      <span className="lbl">UniFi Protect</span>
      <p className="muted" style={{ margin: 0 }}>
        Enter your console's address and an API key (UniFi Protect &rarr; Settings &rarr; Control Plane &rarr; Integrations). The key is used once and not saved.
      </p>
      <input placeholder="Console address, e.g. 192.168.0.1" aria-label="UniFi console address" value={host} onChange={(e) => setHost(e.target.value)} />
      <input type="password" autoComplete="off" placeholder="API key" aria-label="UniFi API key" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" aria-busy={busy} disabled={busy || !host.trim() || !apiKey} onClick={() => void find()}>Find cameras</button>
        <button type="button" className="link" onClick={() => setOpen(false)}>Cancel</button>
      </div>
      {err && <p className="err">{err}</p>}
      {cameras && cameras.length === 0 && <p className="muted">The console has no cameras.</p>}
      {cameras && cameras.length > 0 && (
        <>
          <div className="knx-gw-list">
            {cameras.map((c) => {
              const r = results[c.id];
              return (
                <label key={c.id} className="knx-gw-item" style={{ cursor: "pointer" }}>
                  <div className="knx-gw-name">
                    <input type="checkbox" checked={selected.has(c.id)} onChange={() => toggle(c.id)} style={{ marginRight: 8 }} />
                    {c.name}
                  </div>
                  <div className="knx-gw-meta">
                    {[c.model, c.state].filter(Boolean).join(" · ") || "UniFi camera"}
                    {r && (
                      <span style={{ marginLeft: 8, color: r.status === "failed" ? "var(--aureon-color-status-critical, #e5484d)" : undefined }}>
                        {r.status === "added" ? "Added" : r.status === "already-added" ? "Already added" : `Not added — ${r.reason ?? "unknown problem"}`}
                      </span>
                    )}
                  </div>
                </label>
              );
            })}
          </div>
          <div>
            <button type="button" className="primary" aria-busy={busy} disabled={busy || selected.size === 0} onClick={() => void addSelected()}>
              Add selected
            </button>
          </div>
        </>
      )}
    </div>
  );
}
