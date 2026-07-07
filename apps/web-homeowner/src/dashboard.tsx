import { useEffect, useState } from "react";
import type { SystemHealth } from "@supreme/contracts";
import { client, fetchAutomations, fetchAutomationRuns, fetchDriverRegistry } from "./api.js";
import type { Tab } from "./App.js";
import { FavoritesRow, RecentlyUsedRow } from "./favorites.js";
import { WeatherCard } from "./weather.js";
import { byFrequency } from "./usage.js";
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

export function DashboardOverview({ onNavigate, onOpenRoom, devMode = false }: { onNavigate: (t: Tab) => void; onOpenRoom?: (roomId: string) => void; devMode?: boolean }) {
  const diag = useAsync<Diag>(() => client.diagnostics() as Promise<Diag>);
  const home = useAsync<{ rooms: { id: string; name: string }[] }>(() => client.home() as never);
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

  // What actually needs a decision, in plain homeowner language — nothing when all is well, so the
  // home breathes. Ordered by urgency (§ Dashboard: stop showing statistics users don't care about).
  const attention: { key: string; text: string; tone: "warn" | "info"; go: () => void }[] = [];
  if (security?.triggered) attention.push({ key: "sec", text: "Security alert — check your home", tone: "warn", go: () => onNavigate("security") });
  const offline = diag?.offlineDevices.length ?? 0;
  if (offline > 0) attention.push({ key: "off", text: `${offline} device${offline === 1 ? "" : "s"} offline`, tone: "warn", go: () => onNavigate("devices") });
  if (autoErrors > 0) attention.push({ key: "auto", text: `${autoErrors} automation${autoErrors === 1 ? "" : "s"} need attention`, tone: "warn", go: () => onNavigate("automations") });
  if (pendingCount > 0) attention.push({ key: "pend", text: `${pendingCount} new device${pendingCount === 1 ? "" : "s"} waiting to be added`, tone: "info", go: () => onNavigate("devices") });
  if (update?.updateAvailable || updatesAvailable > 0) attention.push({ key: "upd", text: "A software update is available", tone: "info", go: () => onNavigate("settings") });
  if (backup && backup.schedule.enabled && !backup.lastBackupAt) attention.push({ key: "bak", text: "No backup yet — protect your setup", tone: "info", go: () => onNavigate("settings") });

  const rooms = byFrequency(home?.rooms ?? [], "room").slice(0, 8);

  return (
    <div className="page">
      <div className="page-head dash-head">
        <div>
          <h1 className="title">{greeting()}</h1>
          {devMode && <p className="sub">Supreme OS · {diag ? `v${diag.hubVersion}` : "…"}</p>}
        </div>
        <WeatherCard />
      </div>

      {/* One calm line: all-good, or how many things want a look. Detail lives in the list below. */}
      <div className={`health-hero ${healthy === null ? "" : attention.some((a) => a.tone === "warn") ? "warn" : "ok"}`}>
        <span className="hh-dot" />
        <div style={{ flex: 1 }}>
          <strong>{score === null ? "Checking on your home…" : attention.length === 0 ? "Everything's running beautifully" : attention.length === 1 ? "One thing needs a look" : `${attention.length} things need a look`}</strong>
          {diag && <span className="hh-sub">{diag.counts.devices - offline}/{diag.counts.devices} devices online · {diag.counts.rooms} rooms</span>}
        </div>
      </div>

      {/* Needs attention — real problems only, in plain language. Absent when all is well. */}
      {attention.length > 0 && (
        <div className="attention">
          {attention.map((a) => (
            <button key={a.key} className={`attn-row ${a.tone}`} onClick={a.go}>
              <span className="attn-dot" />
              <span className="attn-text">{a.text}</span>
              <span className="attn-chev">›</span>
            </button>
          ))}
        </div>
      )}

      {/* Favourites — pinned scenes + devices, one tap away */}
      <FavoritesRow onNavigate={onNavigate} />

      {/* Recently used — learns from real use, appears only when there's history (§ Personalization) */}
      <RecentlyUsedRow />

      {/* Your rooms — the home leads, most-used first (§ Home as the interface) */}
      {rooms.length > 0 && (
        <>
          <h2 className="section">Your rooms</h2>
          <div className="room-row">
            {rooms.map((r) => (
              <button key={r.id} className="room-chip" onClick={() => (onOpenRoom ? onOpenRoom(r.id) : onNavigate("rooms"))}>
                {r.name}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Quick actions — the everyday jumps */}
      <h2 className="section">Quick actions</h2>
      <div className="qa-grid">
        <QuickAction icon="scenes" label="Scenes" onClick={() => onNavigate("scenes")} />
        <QuickAction icon="discover" label="Add a device" onClick={() => onNavigate("discover")} />
        <QuickAction icon="energy" label="Energy" onClick={() => onNavigate("energy")} />
        <QuickAction icon="extensions" label="Extensions" onClick={() => onNavigate("extensions")} />
      </div>

      {/* Recent events — the home's recent activity */}
      {events?.items && events.items.length > 0 && (
        <>
          <h2 className="section">Recent activity</h2>
          <div className="ev-list">
            {events.items.slice(0, 5).map((e) => (
              <div className="ev-row" key={e.id}>
                <span className="ev-title">{e.title}</span>
                <span className="ev-time">{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* ── Operations — Installer & Developer only. A homeowner never sees system telemetry. ── */}
      {devMode && (
        <>
          <div className="stat-grid" style={{ marginTop: 18 }}>
            <Stat label="Online devices" value={online ?? "—"} sub={diag ? `of ${diag.counts.devices}` : ""} onClick={() => onNavigate("devices")} good />
            <Stat label="Offline" value={offline} sub={offline ? diag!.offlineDevices.slice(0, 1).map((d) => d.name).join("") : "none"} onClick={() => onNavigate("devices")} warn={offline > 0} />
            <Stat label="Extensions" value={installed.length} sub={extErrors ? `${extErrors} error` : "all healthy"} onClick={() => onNavigate("extensions")} warn={extErrors > 0} />
            <Stat label="Automations" value={autos ? `${autoEnabled}/${autos.length}` : "—"} sub="enabled" onClick={() => onNavigate("automations")} />
            <Stat label="Backups" value={backup ? backup.backupCount : "—"} sub={backup ? (backup.lastBackupAt ? `last ${timeAgo(backup.lastBackupAt)}` : "none yet") : ""} onClick={() => onNavigate("settings")} warn={Boolean(backup && backup.schedule.enabled && !backup.lastBackupAt)} />
            <Stat label="Updates" value={update ? (update.updateAvailable ? "1" : "0") + (updatesAvailable ? `+${updatesAvailable}` : "") : "—"} sub={update?.updateAvailable ? `hub v${update.latest?.version}` : "up to date"} onClick={() => onNavigate("settings")} warn={Boolean(update?.updateAvailable) || updatesAvailable > 0} />
          </div>
          {sys && (
            <>
              <h2 className="section">Hub resources</h2>
              <div className="stat-grid">
                {sys.cpu.utilizationPct !== undefined && <Meter label="CPU" pct={sys.cpu.utilizationPct} sub={`${sys.cpu.cores} cores · load ${sys.cpu.loadAvg1}`} />}
                <Meter label="Memory" pct={sys.memory.usedPct} sub={`${fmtBytes(sys.memory.usedBytes)} / ${fmtBytes(sys.memory.totalBytes)}`} />
                {sys.storage && <Meter label="Storage" pct={sys.storage.usedPct} sub={`${fmtBytes(sys.storage.usedBytes)} / ${fmtBytes(sys.storage.totalBytes)}`} />}
                {sys.temperatureC !== undefined && <Stat label="Temperature" value={`${sys.temperatureC}°`} sub="CPU" warn={sys.temperatureC >= 80} />}
                <Stat label="Uptime" value={fmtUptime(sys.uptimeSeconds)} sub="hub process" />
              </div>
            </>
          )}
          {diag && (
            <div className="hub-line">
              Hub {diag.hubVersion} · backend {diag.backend.kind} <span className={diag.backend.healthy ? "ok" : "err"}>{diag.backend.healthy ? "healthy" : "degraded"}</span>
            </div>
          )}
        </>
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
