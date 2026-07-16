import { useEffect, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { Button, Grid } from "@supreme/aureon-web";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { useOpenDevice } from "./device-detail-router.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";
import { useLive } from "./live.js";

/**
 * Climate (§ Navigation → Climate) — the whole-home view of HVAC units: every device the home
 * exposes with a `temperature` capability, grouped by room. Selecting a unit hands off to the
 * Canonical Device Detail Router (§ Platform Architecture Rule) via `openDevice(id)` — this
 * page never renders the console itself, only routes to it.
 */
type Room = { id: string; name: string };

function climateSummary(d: Device, live: Record<string, unknown>): string {
  const s = { ...d.state, ...live } as Record<string, Record<string, unknown>>;
  const power = s?.onoff as { on?: boolean } | undefined;
  const t = s?.temperature as { targetC?: number | null; mode?: string } | undefined;
  if (!power?.on || !t || t.mode === "off") return "Off";
  const mode = typeof t.mode === "string" ? t.mode[0]!.toUpperCase() + t.mode.slice(1) : "";
  return typeof t.targetC === "number" ? `${t.targetC}°C · ${mode}` : mode || "On";
}

function hasClimateConfig(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "temperature");
}

export function Climate({ onNavigate }: { onNavigate?: (t: Tab) => void; devMode?: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const fav = useFavorites();
  const { states } = useLive();
  const { openDevice, refreshToken } = useOpenDevice();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, [refreshToken]);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const units = (devices ?? []).filter(hasClimateConfig);

  const byRoom = new Map<string, Device[]>();
  for (const d of units) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const allPower = async (on: boolean) => {
    const targets = units.filter((d) => d.capabilities.some((c) => c.kind === "onoff"));
    await Promise.all(targets.map((d) =>
      client.command(d.id as DeviceId, { capability: "onoff", action: on ? "on" : "off" } as CapabilityCommand),
    ));
  };

  return (
    <div className="page">
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="title">Climate</h1>
          <p className="sub">{devices ? `${units.length} unit${units.length === 1 ? "" : "s"} across your home` : "Loading…"}</p>
        </div>
        {units.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => void allPower(true)}>All ON</Button>
            <Button onClick={() => void allPower(false)}>All OFF</Button>
          </div>
        )}
      </div>

      {devices && units.length === 0 && (
        <EmptyState icon="❄" title="No HVAC units yet"
          hint="Air conditioners and thermostats you add will appear here, ready to control — grouped by room."
          action={onNavigate ? { label: "Add a unit", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <Grid minItemWidth={260}>
            {list.map((d) => {
              const summary = climateSummary(d, states[d.id] ?? {});
              return (
                <button key={d.id} className="media-card" onClick={() => openDevice(d.id)}>
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
          </Grid>
        </div>
      ))}
    </div>
  );
}
