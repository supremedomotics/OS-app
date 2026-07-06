import { useEffect, useState } from "react";
import type { SystemHealth } from "@supreme/contracts";
import { client, fetchAutomations, fetchAutomationRuns, fetchDriverRegistry } from "./api.js";
import type { Tab } from "./App.js";
import { Icon } from "./icons.js";

/**
 * Dashboard (§ Dashboard Improvements) — the project overview. Aggregates the real signals the
 * platform actually exposes (hub health, device online/offline, extension health, automations,
 * security, recent events, live host telemetry) into calm stat tiles + quick actions. Host metrics
 * come from the real OS the hub runs on (`/v1/system/health`); any field the platform can't measure
 * (e.g. temperature on hardware without a sensor) is omitted, never shown as a fabricated value.
 */
type Diag = {
  hubVersion: string;
  backend: { kind: string; healthy: boolean };
  counts: { rooms: number; devices: number; scenes: number; drivers: number; users: number };
  drivers: { key: string; version: string; enabled: boolean; status: string }[];
  offlineDevices: { id: string; name: string }[];
};

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(1)} GB`;
  if (n >= 1 << 20) return `${Math.round(n / (1 << 20))} MB`;
  return `${Math.round(n / 1024)} KB`;
}
function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
}
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d > 0 ? `${d}d ago` : h > 0 ? `${h}h ago` : m > 0 ? `${m}m ago` : "just now";
}

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
  const sys = useAsync<SystemHealth>(() => client.systemHealth());
  // Operations signals (§ Installer/Operations Dashboard) — all from endpoints we already expose.
  const backup = useAsync<{ lastBackupAt: string | null; backupCount: number; nextDueAt: string | null; schedule: { enabled: boolean } }>(() => client.backupStatus() as never);
  const update = useAsync<{ updateAvailable: boolean; latest?: { version: string } }>(() => client.systemUpdate() as never);
  const pending = useAsync<{ pending: unknown[] }>(() => client.pendingDevices() as never);
  const autoRuns = useAsync(() => fetchAutomationRuns());

  const online = diag ? diag.counts.devices - diag.offlineDevices.length : null;
  const installed = (registry ?? []).filter((d) => d.installed);
  const extErrors = installed.filter((d) => d.status === "error").length;
  const updatesAvailable = installed.filter((d) => d.updateAvailable).length;
  const autoEnabled = (autos ?? []).filter((a) => a.enabled).length;
  // An automation "error" = a run whose conditions passed but an action failed.
  const autoErrors = (autoRuns ?? []).filter((r) => r.conditionsPassed && !r.ok).length;
  const pendingCount = pending?.pending.length ?? 0;

  // Composite health score (0–100) from real problem signals; informational items (pending
  // approvals, updates) don't dock the score — they're surfaced as their own cards.
  const score = (() => {
    if (!diag) return null;
    let s = 100;
    if (!diag.backend.healthy) s -= 30;
    s -= Math.min(20, diag.offlineDevices.length * 5);
    s -= Math.min(20, extErrors * 10);
    s -= Math.min(15, autoErrors * 5);
    if (backup && backup.schedule.enabled && !backup.lastBackupAt) s -= 15;
    if (security?.triggered) s -= 20;
    return Math.max(0, s);
  })();
  const healthy = score === null ? null : score >= 90;

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">{greeting()}</h1>
        <p className="sub">Supreme OS · {diag ? `v${diag.hubVersion}` : "…"}</p>
      </div>

      {/* Headline project health — a computed operations score (§ Operations Dashboard) */}
      <div className={`health-hero ${healthy === null ? "" : healthy ? "ok" : "warn"}`}>
        <span className="hh-dot" />
        <div style={{ flex: 1 }}>
          <strong>{score === null ? "Checking…" : `Health score ${score}/100 · ${score >= 90 ? "All systems healthy" : score >= 70 ? "Minor issues" : "Attention needed"}`}</strong>
          <span className="hh-sub">
            {diag ? `${online}/${diag.counts.devices} devices online · ${installed.length} extensions${extErrors ? ` · ${extErrors} error` : ""}${autoErrors ? ` · ${autoErrors} automation error${autoErrors === 1 ? "" : "s"}` : ""}` : ""}
          </span>
        </div>
        {score !== null && <span className="health-score">{score}</span>}
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

      {/* Operations cards — backups / updates / pending approvals / driver problems */}
      <div className="stat-grid" style={{ marginTop: 10 }}>
        <Stat label="Backups" value={backup ? backup.backupCount : "—"} sub={backup ? (backup.lastBackupAt ? `last ${timeAgo(backup.lastBackupAt)}` : "none yet") : ""} onClick={() => onNavigate("settings")} warn={Boolean(backup && backup.schedule.enabled && !backup.lastBackupAt)} />
        <Stat label="Updates" value={update ? (update.updateAvailable ? "1" : "0") + (updatesAvailable ? `+${updatesAvailable}` : "") : "—"} sub={update?.updateAvailable ? `hub v${update.latest?.version}` : updatesAvailable ? `${updatesAvailable} extension${updatesAvailable === 1 ? "" : "s"}` : "up to date"} onClick={() => onNavigate("settings")} warn={Boolean(update?.updateAvailable) || updatesAvailable > 0} />
        <Stat label="Pending approval" value={pendingCount} sub={pendingCount ? "review devices" : "none"} onClick={() => onNavigate("devices")} warn={pendingCount > 0} />
        <Stat label="Automation errors" value={autoErrors} sub={autoErrors ? "check activity" : "none"} onClick={() => onNavigate("automations")} warn={autoErrors > 0} />
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

      {/* Hub resources — real host telemetry (§ Installer Dashboard). Only measured fields render. */}
      {sys && (
        <>
          <h2 className="section">Hub resources</h2>
          <div className="stat-grid">
            {sys.cpu.utilizationPct !== undefined && (
              <Meter label="CPU" pct={sys.cpu.utilizationPct} sub={`${sys.cpu.cores} cores · load ${sys.cpu.loadAvg1}`} />
            )}
            <Meter label="Memory" pct={sys.memory.usedPct} sub={`${fmtBytes(sys.memory.usedBytes)} / ${fmtBytes(sys.memory.totalBytes)}`} />
            {sys.storage && (
              <Meter label="Storage" pct={sys.storage.usedPct} sub={`${fmtBytes(sys.storage.usedBytes)} / ${fmtBytes(sys.storage.totalBytes)}`} />
            )}
            {sys.temperatureC !== undefined && (
              <Stat label="Temperature" value={`${sys.temperatureC}°`} sub="CPU" warn={sys.temperatureC >= 80} />
            )}
            <Stat label="Uptime" value={fmtUptime(sys.uptimeSeconds)} sub="hub process" />
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

/** A stat tile with a usage bar (0..100). Turns amber past 80%. */
function Meter({ label, pct, sub }: { label: string; pct: number; sub?: string }) {
  const warn = pct >= 80;
  return (
    <div className={`stat meter${warn ? " warn" : ""}`}>
      <span className="stat-v">{Math.round(pct)}%</span>
      <span className="stat-l">{label}</span>
      <span className="meter-bar"><span className="meter-fill" style={{ width: `${Math.min(100, pct)}%` }} /></span>
      {sub && <span className="stat-s">{sub}</span>}
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
