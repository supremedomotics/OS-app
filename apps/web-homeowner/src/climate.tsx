import { useEffect, useState } from "react";
import type { Device } from "@supreme/domain-model";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { ClimateConsole } from "./climate-console.js";
import { ClimateSchedulerPage } from "./climate-scheduler-ui.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";

/**
 * Climate (§ Navigation → Climate) — the whole-home view of HVAC units: every device the home
 * exposes with a `temperature` capability driven by a real, capability-driven ClimateCapabilityConfig
 * (i.e. genuinely bound to a native driver like CoolMaster — `config.source` is populated), grouped by
 * room. A plain thermostat with no rich config (nothing declared beyond a bare setpoint) isn't listed
 * here; it's still reachable through Rooms/Devices with its existing simple controls — this page is
 * specifically the rich HVAC console, not a second generic-thermostat UI. Selecting a unit opens the
 * rich console as this page's main content — not a modal — matching the Media page's own pattern.
 */
type Room = { id: string; name: string };

function climateSummary(d: Device): string {
  const s = d.state as Record<string, Record<string, unknown>> | undefined;
  const power = s?.onoff as { on?: boolean } | undefined;
  const t = s?.temperature as { targetC?: number | null; mode?: string } | undefined;
  if (!power?.on || !t || t.mode === "off") return "Off";
  const mode = typeof t.mode === "string" ? t.mode[0]!.toUpperCase() + t.mode.slice(1) : "";
  return typeof t.targetC === "number" ? `${t.targetC}°C · ${mode}` : mode || "On";
}

function hasClimateConfig(d: Device): boolean {
  const cap = d.capabilities.find((c) => c.kind === "temperature");
  const config = cap?.config as { source?: string } | undefined;
  return Boolean(config?.source);
}

export function Climate({ onNavigate }: { onNavigate?: (t: Tab) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const fav = useFavorites();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, []);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const units = (devices ?? []).filter(hasClimateConfig);
  const selected = selectedId ? units.find((d) => d.id === selectedId) ?? null : null;
  const scheduling = scheduleId ? units.find((d) => d.id === scheduleId) ?? null : null;

  if (scheduling) {
    const config = (scheduling.capabilities.find((c) => c.kind === "temperature")?.config ?? {}) as { modes?: string[]; fanSpeeds?: string[] };
    return (
      <ClimateSchedulerPage
        device={scheduling}
        modes={config.modes ?? []}
        fanSpeeds={config.fanSpeeds ?? []}
        onBack={() => setScheduleId(null)}
      />
    );
  }

  if (selected) {
    return (
      <ClimateConsole
        device={selected}
        roomName={roomName(selected.roomId)}
        onBack={() => setSelectedId(null)}
        onNavigateDevice={(d) => setSelectedId(d.id)}
        onRemoved={() => { setSelectedId(null); void load(); }}
        onDeviceUpdated={(d) => setDevices((prev) => prev?.map((x) => (x.id === d.id ? d : x)) ?? prev)}
        onOpenSchedule={(d) => setScheduleId(d.id)}
      />
    );
  }

  const byRoom = new Map<string, Device[]>();
  for (const d of units) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Climate</h1>
        <p className="sub">{devices ? `${units.length} unit${units.length === 1 ? "" : "s"} across your home` : "Loading…"}</p>
      </div>

      {devices && units.length === 0 && (
        <EmptyState icon="❄" title="No HVAC units yet"
          hint="Air conditioners and thermostats you add will appear here, ready to control — grouped by room."
          action={onNavigate ? { label: "Add a unit", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <div className="grid">
            {list.map((d) => {
              const summary = climateSummary(d);
              return (
                <button key={d.id} className="media-card" onClick={() => setSelectedId(d.id)}>
                  <span className="media-ic">❄</span>
                  <span className="media-meta">
                    <span className="media-name">{d.name}</span>
                    <span className="media-now">{summary}</span>
                  </span>
                  <FavHeart fav={{ type: "device", deviceId: d.id }}
                    active={fav.isFav({ type: "device", deviceId: d.id })}
                    onToggle={() => fav.toggle({ type: "device", deviceId: d.id })} />
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
