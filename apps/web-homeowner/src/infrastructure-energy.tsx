import { useEffect, useState } from "react";
import type { Device } from "@supreme/domain-model";
import type { EnergySummaryResponse } from "@supreme/contracts";
import { Grid, Icon, PowerRing } from "@supreme/aureon-web";
import type { Tab } from "./App.js";
import { client } from "./api.js";
import { useAsync } from "./use-async.js";
import { useLive } from "./live.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { EmptyState } from "./empty.js";
import { EnergyDeviceDetail } from "./features/infrastructure/energy/detail.js";
import { EnergyDeviceCard } from "./features/infrastructure/energy/card.js";
import { isEnergyDevice } from "./features/infrastructure/energy/capability-mapper.js";

type Room = { id: string; name: string };

/**
 * Infrastructure module — Energy (§ Infrastructure Design Language, first module). Replaces the
 * previous plain `.card.row` whole-home Energy tab (`screens.tsx`) with the same feature-module
 * architecture Media/Security established: a real hero built from `client.energySummary()` (the
 * genuine `/v1/energy/summary` aggregate — no per-second "live power flow" fabricated on top of
 * it, since the backend doesn't report one), a top-consumers list reusing `EnergyDeviceCard`,
 * and a grouped list of every device this module owns (`isEnergyDevice`) drilling into
 * `EnergyDeviceDetail` on selection — the same `selectedId` local-state pattern as `media.tsx`.
 */
export function Energy({ onNavigate }: { onNavigate?: (t: Tab) => void } = {}) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary] = useAsync<EnergySummaryResponse | null>(() => client.energySummary().catch(() => null));
  const { states } = useLive();
  const fav = useFavorites();

  async function load() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void load(); }, []);

  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const energyDevices = (devices ?? []).filter(isEnergyDevice);
  const selected = selectedId ? energyDevices.find((d) => d.id === selectedId) ?? null : null;
  const deviceName = (id: string) => (devices ?? []).find((d) => d.id === id)?.name ?? "A device";

  if (selected) {
    const onDeviceUpdated = (d: Device) => setDevices((prev) => prev?.map((x) => (x.id === d.id ? d : x)) ?? prev);
    return (
      <EnergyDeviceDetail
        device={selected}
        roomName={roomName(selected.roomId)}
        onBack={() => setSelectedId(null)}
        onRemoved={() => { setSelectedId(null); void load(); }}
        onDeviceUpdated={onDeviceUpdated}
      />
    );
  }

  const totalMeasure = summary?.summary.find((m) => m.measure === "power" || m.measure === "energy") ?? summary?.summary[0];
  const hasData = Boolean(summary && (summary.summary.length > 0 || summary.topConsumers.length > 0));

  const byRoom = new Map<string, Device[]>();
  for (const d of energyDevices) { const k = roomName(d.roomId); (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(d); }
  const groups = [...byRoom.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Energy</h1>
        <p className="sub">How this home draws, stores, and spends its power.</p>
      </div>

      <div className="avr-now avr-now--wash" style={{ "--hero-wash-tint": "var(--aureon-color-status-good)" } as React.CSSProperties}>
        <PowerRing
          size={168}
          value={totalMeasure?.total}
          max={totalMeasure ? Math.max(totalMeasure.total * 1.1, 1) : undefined}
          tone="good"
          label={totalMeasure ? `${Math.round(totalMeasure.total)} ${totalMeasure.unit}` : "—"}
          sublabel={totalMeasure ? `Total ${totalMeasure.measure} this period` : "No metered data yet"}
        />
        <div className="avr-now-meta">
          <span className="avr-now-label">WHOLE HOME</span>
          <h3>{energyDevices.length} metered device{energyDevices.length === 1 ? "" : "s"}</h3>
          <p className="avr-now-album">{devices ? `${devices.length} devices in your home` : "Loading…"}</p>
        </div>
      </div>

      {summary && summary.topConsumers.length > 0 && (
        <>
          <h2 className="section">Top consumers</h2>
          <Grid minItemWidth={260}>
            {summary.topConsumers.slice(0, 6).map((t) => (
              <div className="media-card" key={t.deviceId} style={{ cursor: "default" }}>
                <span className="media-ic"><Icon name="trend-up" size={20} /></span>
                <span className="media-meta">
                  <span className="media-name">{deviceName(t.deviceId)}</span>
                  <span className="media-now">{Math.round(t.total)} {t.unit}</span>
                </span>
              </div>
            ))}
          </Grid>
        </>
      )}

      {devices && !hasData && energyDevices.length === 0 && (
        <EmptyState icon="⚡" title="No metered devices yet"
          hint="Smart plugs, inverters, and meters you add will appear here, grouped by room, with real live readings."
          action={onNavigate ? { label: "Add a device", onClick: () => onNavigate("discover") } : undefined} />
      )}

      {groups.map(([room, list]) => (
        <div key={room} className="dev-group">
          <h2 className="section">{room} <span className="chip-n">{list.length}</span></h2>
          <Grid minItemWidth={260}>
            {list.map((d) => (
              <EnergyDeviceCard
                key={d.id}
                device={d}
                liveState={states[d.id]}
                onOpen={() => setSelectedId(d.id)}
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
