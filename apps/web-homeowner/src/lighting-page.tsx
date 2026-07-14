import { useEffect, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { Button, Grid } from "@supreme/aureon-web";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { LightingDetail } from "./lighting.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";
import { useLive } from "./live.js";

/**
 * Lighting (§ Navigation → Lighting) — the whole-home view of every dimmable/colour light,
 * grouped by room, matching the Climate/Media pattern exactly: a room-grouped card grid, an
 * All ON / All OFF pair, and selecting a card opens the same {@link LightingDetail} console
 * every other entry point to a light uses (Rooms → <room> → Lighting, Devices, …) — one
 * canonical detail page, never a page-specific alternate.
 */
type Room = { id: string; name: string };

function isLight(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "brightness" || c.kind === "color");
}

function lightSummary(d: Device, live: Record<string, unknown>): string {
  const s = { ...d.state, ...live } as Record<string, Record<string, unknown>>;
  const brightness = s?.brightness as { on?: boolean; level?: number } | undefined;
  const color = s?.color as { on?: boolean; level?: number } | undefined;
  const onoff = s?.onoff as { on?: boolean } | undefined;
  const on = brightness?.on ?? color?.on ?? onoff?.on ?? false;
  if (!on) return "Off";
  const level = brightness?.level ?? color?.level;
  return typeof level === "number" ? `${Math.round(level)}%` : "On";
}

export function Lighting({ onNavigate, devMode = false }: { onNavigate?: (t: Tab) => void; devMode?: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fav = useFavorites();
  const { states } = useLive();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, []);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const lights = (devices ?? []).filter(isLight);
  const selected = selectedId ? lights.find((d) => d.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <LightingDetail
        device={selected}
        roomName={roomName(selected.roomId)}
        onClose={() => setSelectedId(null)}
        onRemoved={() => { setSelectedId(null); void load(); }}
        devMode={devMode}
      />
    );
  }

  const byRoom = new Map<string, Device[]>();
  for (const d of lights) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const allPower = async (on: boolean) => {
    await Promise.all(lights.map((d) => {
      const capability = d.capabilities.some((c) => c.kind === "brightness") ? "brightness" : d.capabilities.some((c) => c.kind === "color") ? "color" : "onoff";
      return client.command(d.id as DeviceId, { capability, action: on ? "on" : "off" } as CapabilityCommand);
    }));
  };

  return (
    <div className="page">
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="title">Lighting</h1>
          <p className="sub">{devices ? `${lights.length} light${lights.length === 1 ? "" : "s"} across your home` : "Loading…"}</p>
        </div>
        {lights.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => void allPower(true)}>All ON</Button>
            <Button onClick={() => void allPower(false)}>All OFF</Button>
          </div>
        )}
      </div>

      {devices && lights.length === 0 && (
        <EmptyState icon="☀" title="No lights yet"
          hint="Dimmers and colour lights you add will appear here, ready to control — grouped by room."
          action={onNavigate ? { label: "Add a light", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <Grid minItemWidth={260}>
            {list.map((d) => {
              const summary = lightSummary(d, states[d.id] ?? {});
              return (
                <button key={d.id} className="media-card" onClick={() => setSelectedId(d.id)}>
                  <span className="media-ic">☀</span>
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
