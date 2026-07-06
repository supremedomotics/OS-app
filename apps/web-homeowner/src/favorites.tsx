import { useCallback, useEffect, useState } from "react";
import type { Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import type { Tab } from "./App.js";
import { recordUse, recentUses } from "./usage.js";

/**
 * Favorites (§ Favorites) — pin the rooms, devices and scenes you use most so they're one tap away.
 * Reuses the hub's favorites API (favorites / setFavorite); no new backend. A heart toggle lives on
 * device and scene cards; the pinned set surfaces as a row at the top of the Dashboard.
 */
export type FavRef = { type: "device"; deviceId: string } | { type: "scene"; sceneId: string };

function keyOf(ref: FavRef): string {
  return ref.type === "device" ? `device:${ref.deviceId}` : `scene:${ref.sceneId}`;
}

/** Shared favorites state: the pinned key set + a toggle that optimistically updates. */
export function useFavorites() {
  const [keys, setKeys] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await client.favorites();
      setKeys(new Set(res.favorites.map((f) => keyOf(f.ref as FavRef))));
    } catch { /* keep */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const isFav = useCallback((ref: FavRef) => keys.has(keyOf(ref)), [keys]);
  const toggle = useCallback(async (ref: FavRef) => {
    const k = keyOf(ref);
    const next = keys.has(k) ? false : true;
    setKeys((s) => { const n = new Set(s); next ? n.add(k) : n.delete(k); return n; });
    try { await client.setFavorite(ref as never, next); } catch { void load(); }
  }, [keys, load]);

  return { keys, isFav, toggle, refresh: load };
}

/** A heart toggle for any favouritable thing. */
export function FavHeart({ fav, active, onToggle }: { fav: FavRef; active: boolean; onToggle: (r: FavRef) => void }) {
  return (
    <button
      className={`fav-heart${active ? " on" : ""}`}
      title={active ? "Unpin" : "Pin to favourites"}
      onClick={(e) => { e.stopPropagation(); onToggle(fav); }}
      aria-pressed={active}
    >
      {active ? "♥" : "♡"}
    </button>
  );
}

/** The Dashboard favourites row — pinned devices (one-tap toggle) + scenes (one-tap activate). */
export function FavoritesRow({ onNavigate }: { onNavigate: (t: Tab) => void }) {
  const [keys, setKeys] = useState<Set<string> | null>(null);
  const [devices, setDevices] = useState<Device[]>([]);
  const [scenes, setScenes] = useState<{ id: string; name: string; icon: string | null }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    try {
      const [fav, devs, scn] = await Promise.all([client.favorites(), client.devices(), client.scenes()]);
      setKeys(new Set(fav.favorites.map((f) => keyOf(f.ref as FavRef))));
      setDevices(devs.devices);
      setScenes(scn.scenes.map((s) => ({ id: s.id, name: s.name, icon: s.icon ?? null })));
    } catch { setKeys(new Set()); }
  }
  useEffect(() => { void load(); }, []);

  if (!keys || keys.size === 0) return null;
  const favDevices = devices.filter((d) => keys.has(`device:${d.id}`));
  const favScenes = scenes.filter((s) => keys.has(`scene:${s.id}`));

  const isOn = (d: Device) => {
    const s = d.state as Record<string, { on?: boolean }> | undefined;
    return Boolean(s?.brightness?.on ?? s?.onoff?.on);
  };
  async function toggleDevice(d: Device) {
    setBusy(d.id);
    recordUse("device", d.id);
    try { await client.command(d.id as DeviceId, { capability: "onoff", action: "toggle" } as never); await load(); }
    catch { /* ignore */ } finally { setBusy(null); }
  }
  async function activate(id: string) {
    setBusy(id);
    recordUse("scene", id);
    try { await client.activateScene(id); } finally { setBusy(null); }
  }

  return (
    <>
      <h2 className="section">Favourites</h2>
      <div className="fav-row">
        {favScenes.map((s) => (
          <button key={s.id} className="fav-tile scene" disabled={busy === s.id} onClick={() => activate(s.id)}>
            <span className="fav-ic">{s.icon ?? "◆"}</span>
            <span className="fav-name">{s.name}</span>
            <span className="fav-sub">Scene</span>
          </button>
        ))}
        {favDevices.map((d) => (
          <button key={d.id} className={`fav-tile device${isOn(d) ? " on" : ""}`} disabled={busy === d.id} onClick={() => toggleDevice(d)}>
            <span className="fav-ic">{isOn(d) ? "◉" : "○"}</span>
            <span className="fav-name">{d.name}</span>
            <span className="fav-sub">{isOn(d) ? "On" : "Off"}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * Recently used (§ Personalization) — the devices & scenes the homeowner touched most recently,
 * surfaced automatically so the everyday things are always one tap away. Appears ONLY when there's
 * history, so a fresh home stays calm. Sourced from the local usage log — no configuration, no
 * backend, no invented data.
 */
export function RecentlyUsedRow() {
  const [recent, setRecent] = useState<{ kind: "device" | "scene"; id: string }[]>([]);
  const [devices, setDevices] = useState<Device[]>([]);
  const [scenes, setScenes] = useState<{ id: string; name: string; icon: string | null }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    // Only devices & scenes are one-tap re-activatable here; room opens feed ordering elsewhere.
    const rec = recentUses(12).filter((r): r is { kind: "device" | "scene"; id: string } => r.kind !== "room").slice(0, 6);
    setRecent(rec);
    if (rec.length === 0) return;
    try {
      const [devs, scn] = await Promise.all([client.devices(), client.scenes()]);
      setDevices(devs.devices);
      setScenes(scn.scenes.map((s) => ({ id: s.id, name: s.name, icon: s.icon ?? null })));
    } catch { /* keep */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (recent.length === 0) return null;
  const isOn = (d: Device) => {
    const s = d.state as Record<string, { on?: boolean }> | undefined;
    return Boolean(s?.brightness?.on ?? s?.onoff?.on);
  };

  const tiles = recent.map((r) => {
    if (r.kind === "scene") {
      const s = scenes.find((x) => x.id === r.id);
      if (!s) return null;
      return (
        <button key={`s:${s.id}`} className="fav-tile scene" disabled={busy === s.id}
          onClick={async () => { setBusy(s.id); recordUse("scene", s.id); try { await client.activateScene(s.id); } finally { setBusy(null); } }}>
          <span className="fav-ic">{s.icon ?? "◆"}</span>
          <span className="fav-name">{s.name}</span>
          <span className="fav-sub">Scene</span>
        </button>
      );
    }
    const d = devices.find((x) => x.id === r.id);
    if (!d) return null;
    return (
      <button key={`d:${d.id}`} className={`fav-tile device${isOn(d) ? " on" : ""}`} disabled={busy === d.id}
        onClick={async () => { setBusy(d.id); recordUse("device", d.id); try { await client.command(d.id as DeviceId, { capability: "onoff", action: "toggle" } as never); await load(); } finally { setBusy(null); } }}>
        <span className="fav-ic">{isOn(d) ? "◉" : "○"}</span>
        <span className="fav-name">{d.name}</span>
        <span className="fav-sub">{isOn(d) ? "On" : "Off"}</span>
      </button>
    );
  }).filter(Boolean);

  if (tiles.length === 0) return null;
  return (
    <>
      <h2 className="section">Recently used</h2>
      <div className="fav-row">{tiles}</div>
    </>
  );
}
