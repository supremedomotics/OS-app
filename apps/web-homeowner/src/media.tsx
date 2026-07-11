import { useEffect, useState } from "react";
import type { Device } from "@supreme/domain-model";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { AvrConsole } from "./avr-console.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";

/**
 * Media (§ Navigation → Media) — the whole-home view of everything that plays: every device the
 * home already exposes with a `media` capability, grouped by room. Selecting one opens the rich,
 * capability-driven AVR console (§ AVR Detail Page) as this page's main content — not a modal —
 * matching how a real receiver's control surface earns the whole screen. Pure presentation over
 * the real devices()/command() surface — no new backend, no duplicate media system.
 */
type Room = { id: string; name: string };

function nowPlaying(d: Device): string {
  const s = d.state as Record<string, Record<string, unknown>> | undefined;
  const m = s?.media;
  if (!m) return "Idle";
  const title = (m.title as string) ?? "";
  const artist = (m.artist as string) ?? "";
  const playing = m.playback === "playing";
  if (title) return artist ? `${title} · ${artist}` : title;
  return playing ? "Playing" : "Idle";
}

export function Media({ onNavigate }: { onNavigate?: (t: Tab) => void }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fav = useFavorites();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, []);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const media = (devices ?? []).filter((d) => d.capabilities.some((c) => c.kind === "media"));
  const selected = selectedId ? media.find((d) => d.id === selectedId) ?? null : null;

  if (selected) {
    return (
      <AvrConsole
        device={selected}
        allDevices={media}
        homeDevices={devices ?? []}
        roomName={roomName(selected.roomId)}
        onBack={() => setSelectedId(null)}
        onNavigateDevice={(d) => setSelectedId(d.id)}
        onRemoved={() => { setSelectedId(null); void load(); }}
      />
    );
  }

  const byRoom = new Map<string, Device[]>();
  for (const d of media) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Media</h1>
        <p className="sub">{devices ? `${media.length} player${media.length === 1 ? "" : "s"} across your home` : "Loading…"}</p>
      </div>

      {devices && media.length === 0 && (
        <EmptyState icon="♪" title="No media players yet"
          hint="Speakers and TVs you add will appear here, ready to play — grouped by room."
          action={onNavigate ? { label: "Add a player", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <div className="grid">
            {list.map((d) => {
              const playing = nowPlaying(d);
              return (
                <button key={d.id} className="media-card" onClick={() => setSelectedId(d.id)}>
                  <span className="media-ic">♪</span>
                  <span className="media-meta">
                    <span className="media-name">{d.name}</span>
                    <span className="media-now">{playing}</span>
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
