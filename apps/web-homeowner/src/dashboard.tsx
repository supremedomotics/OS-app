import { useEffect, useState } from "react";
import { client, fetchAutomations, fetchDriverRegistry } from "./api.js";
import type { Tab } from "./App.js";
import { Icon } from "./icons.js";

/**
 * Dashboard (§ Dashboard Improvements) — the project overview. Aggregates the real signals the
 * platform actually exposes (hub health, device online/offline, extension health, automations,
 * security, recent events) into calm stat tiles + quick actions. Metrics without a backend source
 * (CPU/memory/temperature/firmware) are intentionally omitted rather than shown as placeholders.
 */
type Diag = {
  hubVersion: string;
  backend: { kind: string; healthy: boolean };
  counts: { rooms: number; devices: number; scenes: number; drivers: number; users: number };
  drivers: { key: string; version: string; enabled: boolean; status: string }[];
  offlineDevices: { id: string; name: string }[];
};

function useAsync<T>(fn: () => Promise<T>): T | null {
  const [v, setV] = useState<T | null>(null);
  useEffect(() => { let live = true; fn().then((x) => live && setV(x)).catch(() => {}); return () => { live = false; }; }, []);
  return v;
}

export function DashboardOverview({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const diag = useAsync<Diag>(() => client.diagnostics() as Promise<Diag>);
  const registry = useAsync(() => fetchDriverRegistry());
  const autos = useAsync(() => fetchAutomations());
  const security = useAsync<{ armMode?: string; triggered?: boolean }>(() => client.securityState() as Promise<{ armMode?: string; triggered?: boolean }>);
  const events = useAsync<{ items?: { id: string; title: string; createdAt: string }[] }>(() => client.notifications() as Promise<{ items?: { id: string; title: string; createdAt: string }[] }>);

  const online = diag ? diag.counts.devices - diag.offlineDevices.length : null;
  const installed = (registry ?? []).filter((d) => d.installed);
  const extErrors = installed.filter((d) => d.status === "error").length;
  const autoEnabled = (autos ?? []).filter((a) => a.enabled).length;
  const healthy = diag ? diag.backend.healthy && diag.offlineDevices.length === 0 && extErrors === 0 : null;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">{greeting()}</h1>
        <p className="sub">Supreme OS · {diag ? `v${diag.hubVersion}` : "…"}</p>
      </div>

      {/* Headline project health */}
      <div className={`health-hero ${healthy === null ? "" : healthy ? "ok" : "warn"}`}>
        <span className="hh-dot" />
        <div>
          <strong>{healthy === null ? "Checking…" : healthy ? "All systems healthy" : "Attention needed"}</strong>
          <span className="hh-sub">
            {diag ? `${online}/${diag.counts.devices} devices online · ${installed.length} extensions${extErrors ? ` · ${extErrors} error` : ""}` : ""}
          </span>
        </div>
      </div>

      {/* Stat tiles — real data only */}
      <div className="stat-grid">
        <Stat label="Online devices" value={online ?? "—"} sub={diag ? `of ${diag.counts.devices}` : ""} onClick={() => onNavigate("devices")} good />
        <Stat label="Offline" value={diag?.offlineDevices.length ?? "—"} sub={diag?.offlineDevices.length ? diag.offlineDevices.slice(0, 1).map((d) => d.name).join("") : "none"} onClick={() => onNavigate("devices")} warn={Boolean(diag?.offlineDevices.length)} />
        <Stat label="Extensions" value={installed.length} sub={extErrors ? `${extErrors} error` : "all healthy"} onClick={() => onNavigate("extensions")} warn={extErrors > 0} />
        <Stat label="Automations" value={autos ? `${autoEnabled}/${autos.length}` : "—"} sub="enabled" onClick={() => onNavigate("automations")} />
        <Stat label="Security" value={security?.triggered ? "Alert" : cap(security?.armMode ?? "—")} sub={security?.triggered ? "triggered" : "armed state"} onClick={() => onNavigate("security")} warn={Boolean(security?.triggered)} />
        <Stat label="Rooms · Scenes" value={diag ? `${diag.counts.rooms} · ${diag.counts.scenes}` : "—"} sub="in this home" onClick={() => onNavigate("rooms")} />
      </div>

      {/* Quick actions */}
      <h2 className="section">Quick actions</h2>
      <div className="qa-grid">
        <QuickAction icon="discover" label="Discover Devices" onClick={() => onNavigate("discover")} />
        <QuickAction icon="extensions" label="Extension Center" onClick={() => onNavigate("extensions")} />
        <QuickAction icon="scenes" label="Scenes" onClick={() => onNavigate("scenes")} />
        <QuickAction icon="energy" label="Energy" onClick={() => onNavigate("energy")} />
      </div>

      {/* Recent events */}
      {events?.items && events.items.length > 0 && (
        <>
          <h2 className="section">Recent events</h2>
          <div className="ev-list">
            {events.items.slice(0, 6).map((e) => (
              <div className="ev-row" key={e.id}>
                <span className="ev-title">{e.title}</span>
                <span className="ev-time">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Hub */}
      {diag && (
        <div className="hub-line">
          Hub {diag.hubVersion} · backend {diag.backend.kind} <span className={diag.backend.healthy ? "ok" : "err"}>{diag.backend.healthy ? "healthy" : "degraded"}</span>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, sub, onClick, good, warn }: { label: string; value: React.ReactNode; sub?: string; onClick?: () => void; good?: boolean; warn?: boolean }) {
  return (
    <button className={`stat${warn ? " warn" : good ? " good" : ""}`} onClick={onClick}>
      <span className="stat-v">{value}</span>
      <span className="stat-l">{label}</span>
      {sub && <span className="stat-s">{sub}</span>}
    </button>
  );
}

function QuickAction({ icon, label, onClick }: { icon: "discover" | "extensions" | "scenes" | "energy"; label: string; onClick: () => void }) {
  return (
    <button className="qa" onClick={onClick}>
      <span className="qa-ic"><Icon name={icon} /></span>
      <span>{label}</span>
    </button>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : h < 21 ? "Good evening" : "Good night";
}
const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
