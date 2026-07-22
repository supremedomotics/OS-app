import { useEffect, useState } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { Button, Grid } from "@supreme/aureon-web";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { MediaDeviceCard } from "./features/media/card.js";
import { useOpenDevice } from "./device-detail-router.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";
import { getDeviceUiCapabilities, hasCapability } from "./device-ui-capabilities.js";

/**
 * Media (§ Navigation → Media) — the whole-home view of everything that plays: every device the
 * home already exposes with a `media` capability, grouped by room. Selecting one hands off to
 * the Canonical Device Detail Router (§ Platform Architecture Rule) via `openDevice(id)`, which
 * decides between the AVR console and the simple TV/projector page — this page never renders
 * either itself.
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

export function Media({ onNavigate }: { onNavigate?: (t: Tab) => void; devMode?: boolean }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const fav = useFavorites();
  const { openDevice, refreshToken } = useOpenDevice();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, [refreshToken]);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const media = (devices ?? []).filter((d) => getDeviceUiCapabilities(d.capabilities).showMedia);

  const byRoom = new Map<string, Device[]>();
  for (const d of media) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  const allPower = async (on: boolean) => {
    const targets = media.filter((d) => hasCapability(d.capabilities, "onoff"));
    await Promise.all(targets.map((d) =>
      client.command(d.id as DeviceId, { capability: "onoff", action: on ? "on" : "off" } as CapabilityCommand),
    ));
  };

  return (
    <div className="page">
      <div className="page-head" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <h1 className="title">Media</h1>
          <p className="sub">{devices ? `${media.length} player${media.length === 1 ? "" : "s"} across your home` : "Loading…"}</p>
        </div>
        {media.length > 0 && (
          <div style={{ display: "flex", gap: 8 }}>
            <Button onClick={() => void allPower(true)}>All ON</Button>
            <Button onClick={() => void allPower(false)}>All OFF</Button>
          </div>
        )}
      </div>

      {devices && media.length === 0 && (
        <EmptyState icon="♪" title="No media players yet"
          hint="Speakers and TVs you add will appear here, ready to play — grouped by room."
          action={onNavigate ? { label: "Add a player", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <Grid minItemWidth={260}>
            {list.map((d) => (
              <MediaDeviceCard
                key={d.id}
                device={d}
                status={nowPlaying(d)}
                onOpen={() => openDevice(d.id)}
                trailing={
                  <FavHeart fav={{ type: "device", deviceId: d.id }}
                    active={fav.isFav({ type: "device", deviceId: d.id })}
                    onToggle={() => fav.toggle({ type: "device", deviceId: d.id })} />
                }
              />
            ))}
          </Grid>
        </div>
      ))}
    </div>
  );
}
