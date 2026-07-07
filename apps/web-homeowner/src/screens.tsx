import { useEffect, useRef, useState } from "react";
import { useHeroFlip } from "./herotransition.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { recordUse, byFrequency } from "./usage.js";
import { friendlyError } from "./errors.js";
import { EmptyState } from "./empty.js";
import type {
  CameraStreamResponse,
  EnergySummaryResponse,
  HomeView,
  SecurityStateResponse,
} from "@supreme/contracts";
import type {
  CapabilityCommand,
  Device,
  DeviceId,
  RoomId,
  Scene,
} from "@supreme/domain-model";
import { client } from "./api.js";
import { useRoomPhoto, styleForPhoto, ensureRoomHeroes, type RoomLike } from "./room-image.js";
import { useLive } from "./live.js";
import { LightingDetail } from "./lighting.js";
import { DeviceSheet } from "./device-sheets.js";
import { TabletRoom } from "./tablet-room.js";
import { HlsPlayer, WebRtcPlayer } from "./players.js";
import { Icon } from "./icons.js";

/** True on tablet/desktop widths — switches the room to the Ovio bento layout. */
function useWide(): boolean {
  const [wide, setWide] = useState(typeof window !== "undefined" && window.innerWidth >= 900);
  useEffect(() => {
    const on = () => setWide(window.innerWidth >= 900);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return wide;
}

function useAsync<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, () => void] {
  const [value, setValue] = useState<T | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    // Swallow per-endpoint failures (e.g. energy needs the DB-backed analytics) so one
    // unavailable surface degrades to empty rather than breaking the screen.
    load()
      .then((v) => live && setValue(v))
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [value, () => setN((x) => x + 1)];
}

// ── Dashboard ──────────────────────────────────────────────────────────────────
function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

/** A room tile: a real interior photo (hub-stored or fetched), else a designed motif gradient. */
function RoomCard({ room, onOpen }: { room: RoomLike; onOpen: (rect: DOMRect) => void }) {
  const photo = useRoomPhoto(room, client);
  const { emoji, ...style } = styleForPhoto(photo, room);
  return (
    <div className="room-card has-image" style={style} onClick={(e) => onOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}>
      {emoji && <span className="room-motif" aria-hidden>{emoji}</span>}
      <span className="name">{room.name}</span>
    </div>
  );
}

export function Dashboard({ onOpenRoom, onNavigate }: { onOpenRoom: (roomId: string) => void; onNavigate: (tab: "automations" | "energy") => void }) {
  const [home, refreshHome] = useAsync<HomeView>(() => client.home());
  const [scenes] = useAsync<Scene[]>(async () => (await client.scenes()).scenes);
  const [activeScene, setActiveScene] = useState<string | null>(null);

  const rooms = home?.rooms ?? [];
  // First time a room has no stored hero, ask the hub to download & save one locally, then refresh
  // so the hub-served (identical-everywhere) image replaces the stock fallback.
  useEffect(() => {
    if (rooms.length === 0) return;
    let live = true;
    void ensureRoomHeroes(client, rooms).then((pinned) => { if (pinned && live) refreshHome(); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rooms.length]);
  // Home hero: a representative room's photo when one exists, else the home's own designed gradient.
  const heroRoom = rooms.find((r) => r.heroImageUrl) ?? rooms[0] ?? { name: home?.home.name ?? "Home" };
  const heroPhoto = useRoomPhoto(heroRoom, client);
  const heroStyle = styleForPhoto(heroPhoto, heroRoom, 0.6);

  return (
    <div>
      <h1 className="greet">{greetingFor(new Date())}</h1>

      {scenes && scenes.length > 0 && (
        <div className="scene-tiles">
          {scenes.map((s) => (
            <button
              key={s.id}
              className={`scene-tile${activeScene === s.id ? " on" : ""}`}
              onClick={() => { recordUse("scene", s.id); void client.activateScene(s.id); setActiveScene(s.id); }}
            >
              <span className="play">{activeScene === s.id ? (s.icon ?? "◆") : "▷"}</span>
              <span className="nm">{s.name}</span>
            </button>
          ))}
        </div>
      )}

      {/* One focal element: the home hero (photo → designed motif gradient). */}
      <div className="hero" style={{ backgroundImage: heroStyle.backgroundImage, backgroundSize: heroStyle.backgroundSize }}>
        {heroStyle.emoji && <span className="room-motif" aria-hidden>{heroStyle.emoji}</span>}
        <div className="hero-top">{home?.home.name ?? "Home"}</div>
        <div className="hero-stats">
          <div>
            <strong>All calm</strong>
            <span>{rooms.length} {rooms.length === 1 ? "room" : "rooms"}</span>
          </div>
        </div>
      </div>

      <div className="quick-row">
        <button className="quick" onClick={() => onNavigate("automations")}><span className="qic"><Icon name="automations" size={18} /></span>Automations</button>
        <button className="quick" onClick={() => onNavigate("energy")}><span className="qic"><Icon name="energy" size={18} /></span>Energy</button>
      </div>

      <div className="grid">
        {(home?.rooms ?? []).map((r) => (
          <RoomCard key={r.id} room={r} onOpen={() => onOpenRoom(r.id)} />
        ))}
      </div>
    </div>
  );
}

// ── Rooms ────────────────────────────────────────────────────────────────────
export function RoomsScreen({
  selected,
  onSelect,
}: {
  selected: string | null;
  onSelect: (roomId: string | null) => void;
}) {
  const [home, refresh] = useAsync<HomeView>(() => client.home());
  const wide = useWide();
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  // The tapped room card's rect — origin for the hero FLIP into the room detail.
  const heroOrigin = useRef<DOMRect | null>(null);

  const roomsForHero = home?.rooms ?? [];
  useEffect(() => {
    if (roomsForHero.length === 0) return;
    let live = true;
    void ensureRoomHeroes(client, roomsForHero).then((pinned) => { if (pinned && live) refresh(); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomsForHero.length]);

  async function createRoom() {
    if (!newName.trim()) return;
    try {
      await client.createRoom({ name: newName.trim() });
      setNewName("");
      setAdding(false);
      setErr(null);
      refresh();
    } catch (e) {
      setErr(friendlyError(e, "Could not add the room. Please try again."));
    }
  }

  if (selected) {
    const room = home?.rooms.find((r) => r.id === selected);
    if (wide) return <TabletRoom roomId={selected} name={room?.name ?? "Room"} heroImageUrl={room?.heroImageUrl ?? null} heroOrigin={heroOrigin.current} onBack={() => onSelect(null)} />;
    return (
      <RoomDevices
        roomId={selected}
        name={room?.name ?? "Room"}
        heroImageUrl={room?.heroImageUrl ?? null}
        heroOrigin={heroOrigin.current}
        onBack={() => onSelect(null)}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 className="title">Rooms</h1>
        <button className="primary" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add room"}</button>
      </div>
      <p className="sub">Choose a room to control.</p>
      {adding && (
        <div className="card" style={{ marginBottom: 12 }}>
          <input placeholder="Room name (e.g. Home Gym)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createRoom()} autoFocus />
          {err && <p className="err">{err}</p>}
          <button className="primary" disabled={!newName.trim()} onClick={createRoom} style={{ marginTop: 8 }}>Create room</button>
        </div>
      )}
      <div className="grid">
        {/* Frequently-used rooms move higher (§ Personalization) — a stable order until the home has
            usage history, then the rooms you open most float to the top. */}
        {byFrequency(home?.rooms ?? [], "room").map((r) => (
          <RoomCard key={r.id} room={r} onOpen={(rect) => { heroOrigin.current = rect; recordUse("room", r.id); onSelect(r.id); }} />
        ))}
      </div>
    </div>
  );
}

function RoomDevices({ roomId, name, heroImageUrl, heroOrigin, onBack }: { roomId: string; name: string; heroImageUrl: string | null; heroOrigin: DOMRect | null; onBack: () => void }) {
  const heroRef = useHeroFlip<HTMLDivElement>(heroOrigin);
  const [devices] = useAsync<Device[]>(async () => (await client.devicesInRoom(roomId as RoomId)).devices, [roomId]);
  const roomPhoto = useRoomPhoto({ id: roomId, name, heroImageUrl }, client);
  const [detail, setDetail] = useState<Device | null>(null);
  const [sheet, setSheet] = useState<Device | null>(null);
  const list = devices ?? [];
  const open = (d: Device) => {
    const caps = d.capabilities.map((c) => c.kind);
    if (caps.includes("brightness") || caps.includes("color")) setDetail(d);
    else if (["temperature", "position", "lock", "fan", "vacuum", "onoff", "media"].some((k) => caps.includes(k as never))) setSheet(d);
  };
  if (detail) return <LightingDetail device={detail} onClose={() => setDetail(null)} />;
  return (
    <div>
      <button className="back" onClick={onBack}>
        ‹ Rooms
      </button>
      {/* Room hero — entering a room should feel like entering the space. */}
      {(() => {
        const { emoji, ...s } = styleForPhoto(roomPhoto, { name, heroImageUrl }, 0.66);
        return (
          <div ref={heroRef} className="hero room has-image" style={s}>
            {emoji && <span className="room-motif" aria-hidden>{emoji}</span>}
            <div className="hero-top">{name}</div>
            <div className="hero-stats">
              <div>
                <strong>{list.length}</strong>
                <span>{list.length === 1 ? "device" : "devices"}</span>
              </div>
            </div>
          </div>
        );
      })()}
      <div className="dlist">
        {list.map((d) => (
          <DeviceTile key={d.id} device={d} onOpen={() => open(d)} />
        ))}
      </div>
      {devices && list.length === 0 && (
        <EmptyState icon="◎" title="This room is empty"
          hint="Devices you assign to this room will appear here. Add one from Discover Devices or move an existing device into this room." />
      )}
      {sheet && <DeviceSheet device={sheet} onClose={() => setSheet(null)} />}
    </div>
  );
}

// ── Device tile — Ovio "tile-as-control": horizontal, fill = value, drag to set ──
function DeviceTile({ device, onOpen }: { device: Device; onOpen?: () => void }) {
  const { states, apply } = useLive();
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const moved = useRef(false);
  const live = states[device.id] ?? {};
  const caps = device.capabilities.map((c) => c.kind);
  const merged = { ...device.state, ...live } as Record<string, { on?: boolean; level?: number; value?: number; unit?: string; position?: number }>;
  const isDimmer = caps.includes("brightness");
  const isCover = !isDimmer && caps.includes("position");
  const isSwitch = !isDimmer && !isCover && caps.includes("onoff");
  const isSensor = !isDimmer && !isSwitch && !isCover && caps.includes("sensor");
  const slidable = isDimmer || isCover;

  const bright = merged.brightness;
  const onoff = merged.onoff;
  const cover = merged.position;
  const on = bright?.on ?? onoff?.on ?? (cover?.position ?? 0) > 0;
  const level = isDimmer ? bright?.level ?? (on ? 100 : 0) : isCover ? cover?.position ?? 0 : on ? 100 : 0;

  async function toggle() {
    const next = !on;
    recordUse("device", device.id);
    apply(device.id, isDimmer ? "brightness" : "onoff", isDimmer ? { kind: "brightness", on: next, level: next ? Math.max(level, 1) : 0 } : { kind: "onoff", on: next });
    await client.command(device.id as DeviceId, { capability: "onoff", action: "toggle" } as CapabilityCommand);
  }
  async function setLevel(v: number) {
    const val = Math.max(0, Math.min(100, Math.round(v)));
    if (isDimmer) {
      apply(device.id, "brightness", { kind: "brightness", on: val > 0, level: val });
      await client.command(device.id as DeviceId, { capability: "brightness", action: "set", level: val } as CapabilityCommand);
    } else {
      apply(device.id, "position", { kind: "position", position: val, moving: false });
      await client.command(device.id as DeviceId, { capability: "position", action: "set", position: val } as CapabilityCommand);
    }
  }
  function fromClientX(clientX: number) {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    void setLevel(((clientX - r.left) / r.width) * 100);
  }

  if (isSensor) {
    const s = merged.sensor;
    return (
      <div className="dtile sensor">
        <DeviceIcon kind="sensor" on={false} />
        <span className="nm">{device.name}</span>
        <span className="rv">{s?.value ?? "—"} {s?.unit ?? ""}</span>
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`dtile${on ? " on" : ""}`}
      onClick={slidable ? undefined : (onOpen ? () => onOpen() : toggle)}
      onPointerDown={slidable ? (e) => { dragging.current = true; moved.current = false; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } : undefined}
      onPointerMove={slidable ? (e) => { if (dragging.current) { moved.current = true; fromClientX(e.clientX); } } : undefined}
      onPointerUp={slidable ? () => { dragging.current = false; if (!moved.current) onOpen?.(); } : undefined}
    >
      <div className="fill" style={{ width: `${level}%` }} />
      <DeviceIcon kind={isDimmer ? "light" : isCover ? "cover" : "switch"} on={on} />
      <span className="nm">{device.name}</span>
      <span className="rv">{slidable ? `${Math.round(level)}%` : on ? "On" : "Off"}</span>
    </div>
  );
}

/** Minimal Aureon line icons (monochrome, theme-aware via currentColor). */
function DeviceIcon({ kind, on }: { kind: "light" | "cover" | "switch" | "sensor"; on: boolean }) {
  const paths: Record<string, string> = {
    light: "M9 18h6M10 21h4M12 3a6 6 0 0 0-4 10.5c.7.6 1 1 1 2v.5h6V15c0-1 .3-1.4 1-2A6 6 0 0 0 12 3Z",
    cover: "M4 4h16M5 4v13a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4M9 19v2M15 19v2",
    switch: "M8 6h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 6Zm0 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
    sensor: "M12 3v18M3 12h18",
  };
  return (
    <svg className={`dic${on ? " on" : ""}`} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[kind]} />
    </svg>
  );
}

// ── Scenes — Ovio interactive cards with drag-to-reorder edit mode ─────────────
const SCENE_ORDER_KEY = "supreme.sceneOrder";

export function Scenes() {
  const [scenes, refresh] = useAsync<Scene[]>(async () => (await client.scenes()).scenes);
  const fav = useFavorites();
  const [order, setOrder] = useState<string[]>([]);
  const [edit, setEdit] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  // Long-press (or right-click) a scene to reveal quick actions — one gesture, no extra chrome.
  const [menu, setMenu] = useState<Scene | null>(null);
  const lpTimer = useRef<number | undefined>(undefined);
  const lpFired = useRef(false);
  const lpStart = (s: Scene) => { lpFired.current = false; lpTimer.current = window.setTimeout(() => { lpFired.current = true; setMenu(s); }, 500); };
  const lpEnd = () => window.clearTimeout(lpTimer.current);

  // "Add scene" snapshots the CURRENT state of every device, so the new scene recreates the room
  // exactly as it is now. The user names it; later they can refine it in the automation builder.
  async function addScene() {
    const name = newName.trim();
    if (!name) return;
    try {
      const devs = (await client.devices()).devices;
      const steps: { deviceId: string; capability: string; values: Record<string, unknown> }[] = [];
      for (const d of devs) {
        const state = d.state as Record<string, Record<string, unknown>>;
        for (const cap of ["onoff", "brightness", "color"]) {
          if (d.capabilities.some((c) => c.kind === cap) && state[cap]) {
            const { kind: _kind, ...values } = state[cap]!;
            steps.push({ deviceId: d.id, capability: cap, values });
          }
        }
      }
      await client.createScene({ name, scope: "home", steps });
      setNewName("");
      setAdding(false);
      setMsg(`Scene "${name}" saved`);
      refresh();
    } catch (e) {
      setMsg(friendlyError(e, "Couldn't save the scene. Please try again."));
    }
  }

  // Establish/merge the persisted custom order whenever the scene set changes.
  useEffect(() => {
    if (!scenes) return;
    const saved: string[] = JSON.parse(localStorage.getItem(SCENE_ORDER_KEY) ?? "[]");
    const ids = scenes.map((s) => s.id as string);
    setOrder([...saved.filter((id) => ids.includes(id)), ...ids.filter((id) => !saved.includes(id))]);
  }, [scenes]);

  const ordered = order
    .map((id) => scenes?.find((s) => s.id === id))
    .filter((s): s is Scene => Boolean(s));

  function move(from: string, to: string) {
    setOrder((cur) => {
      const next = [...cur];
      const fi = next.indexOf(from);
      const ti = next.indexOf(to);
      if (fi < 0 || ti < 0) return cur;
      next.splice(ti, 0, next.splice(fi, 1)[0]!);
      return next;
    });
  }
  function save() {
    localStorage.setItem(SCENE_ORDER_KEY, JSON.stringify(order));
    setEdit(false);
    setMsg("Order saved");
  }

  return (
    <div>
      <div className="screen-head">
        <div>
          <p className="sub" style={{ margin: 0 }}>One tap to set the mood</p>
          <h1 className="title">Scenes</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="primary" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add scene"}</button>
          <button className={`edit-btn${edit ? " on" : ""}`} onClick={() => (edit ? save() : setEdit(true))}>
            {edit ? "Save" : "Edit"}
          </button>
        </div>
      </div>

      {adding && (
        <div className="card" style={{ marginBottom: 12 }}>
          <p className="muted" style={{ marginTop: 0 }}>Captures the current state of every device as a one-tap scene.</p>
          <input placeholder="Scene name (e.g. Movie Night)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addScene()} autoFocus />
          <button className="primary" disabled={!newName.trim()} onClick={addScene} style={{ marginTop: 8 }}>Save current setup as scene</button>
        </div>
      )}

      <div className="scene-grid">
        {ordered.map((s) => (
          <div
            key={s.id}
            className={`scene-card${edit ? " editing" : ""}${dragId === s.id ? " dragging" : ""}`}
            draggable={edit}
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => { if (edit && dragId && dragId !== s.id) { e.preventDefault(); move(dragId, s.id); } }}
            onPointerDown={() => { if (!edit) lpStart(s); }}
            onPointerUp={lpEnd}
            onPointerLeave={lpEnd}
            onContextMenu={(e) => { if (!edit) { e.preventDefault(); setMenu(s); } }}
            onClick={() => {
              if (edit) return;
              if (lpFired.current) { lpFired.current = false; return; } // a long-press opened the menu — don't also activate
              recordUse("scene", s.id);
              void client.activateScene(s.id);
              setMsg(`${s.name} activated`);
            }}
          >
            <span className="play">{edit ? "⠿" : s.icon ? s.icon : "▷"}</span>
            <span className="nm">{s.name}</span>
            {!edit && <FavHeart fav={{ type: "scene", sceneId: s.id }} active={fav.isFav({ type: "scene", sceneId: s.id })} onToggle={fav.toggle} />}
          </div>
        ))}
      </div>
      {scenes !== null && ordered.length === 0 && !adding && (
        <EmptyState icon="✦" title="No scenes yet"
          hint="A scene sets many devices at once — “Movie Night”, “Good Morning”, “Away”. Arrange your home, then save it as a scene."
          action={{ label: "Add scene", onClick: () => setAdding(true) }} />
      )}
      {edit && <p className="muted">Drag the cards to reorder, then Save.</p>}
      {!edit && msg && <p className="muted">{msg}</p>}
      {menu && (
        <SceneQuickActions
          scene={menu}
          isFav={fav.isFav({ type: "scene", sceneId: menu.id })}
          onClose={() => setMenu(null)}
          onRun={() => { recordUse("scene", menu.id); void client.activateScene(menu.id); setMsg(`${menu.name} activated`); setMenu(null); }}
          onFav={() => { void fav.toggle({ type: "scene", sceneId: menu.id }); }}
          onChanged={() => { refresh(); }}
        />
      )}
    </div>
  );
}

/**
 * Scene quick actions (§ Quick Actions) — the calm sheet a long-press (or right-click) reveals: run
 * it now, pin/unpin, rename, or remove. Reuses the existing scene API (activate / updateScene /
 * deleteScene) — no new backend. Rename & delete reach routes the gateway already exposes.
 */
function SceneQuickActions({ scene, isFav, onClose, onRun, onFav, onChanged }: {
  scene: Scene; isFav: boolean; onClose: () => void; onRun: () => void; onFav: () => void; onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(scene.name);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function rename() {
    const n = name.trim();
    if (!n || n === scene.name) { setRenaming(false); return; }
    setBusy(true); setErr(null);
    try { await client.updateScene(scene.id, { name: n }); onChanged(); onClose(); }
    catch (e) { setErr(friendlyError(e, "Couldn't rename the scene.")); setBusy(false); }
  }
  async function remove() {
    if (!window.confirm(`Remove the scene "${scene.name}"?`)) return;
    setBusy(true); setErr(null);
    try { await client.deleteScene(scene.id); onChanged(); onClose(); }
    catch (e) { setErr(friendlyError(e, "Couldn't remove the scene.")); setBusy(false); }
  }

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <span className="grab" />
        <div className="sheet-title"><h2>{scene.name}</h2><p>Scene</p></div>
        {renaming ? (
          <div className="qa-rename">
            <input value={name} autoFocus onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && rename()} />
            <button className="primary" disabled={busy || !name.trim()} onClick={rename}>Save</button>
          </div>
        ) : (
          <div className="qa-list">
            <button className="qa-item" onClick={onRun}>▷ Run now</button>
            <button className="qa-item" onClick={() => { onFav(); onClose(); }}>{isFav ? "♥ Unpin from favourites" : "♡ Pin to favourites"}</button>
            <button className="qa-item" onClick={() => setRenaming(true)}>✎ Rename</button>
            <button className="qa-item danger" disabled={busy} onClick={remove}>✕ Remove scene</button>
          </div>
        )}
        {err && <p className="err">{err}</p>}
      </div>
    </div>
  );
}

// ── Security + Cameras ─────────────────────────────────────────────────────────
export function Security() {
  const [state, reload] = useAsync<SecurityStateResponse>(() => client.securityState());
  const [cameras] = useAsync(async () => (await client.cameras()).cameras);
  const [active, setActive] = useState<{ webrtc: string | null; hls: string | null; mode: "webrtc" | "hls" } | null>(null);

  async function arm(mode: "armed_home" | "armed_away" | "armed_night") {
    await client.arm(mode);
    reload();
  }

  async function play(id: string) {
    const { streams } = (await client.cameraStream(id)) as CameraStreamResponse;
    const webrtc = streams.find((s) => s.kind === "webrtc")?.url ?? null;
    const hls = streams.find((s) => s.kind === "hls")?.url ?? null;
    setActive({ webrtc, hls, mode: webrtc ? "webrtc" : "hls" });
  }

  return (
    <div>
      <h1 className="title">Security</h1>
      <div className={`card${state?.triggered ? " alarm" : ""}`}>
        <strong>{state?.triggered ? "ALARM TRIGGERED" : label(state?.mode ?? "disarmed")}</strong>
        <p className="muted">Current mode: {state?.mode ?? "—"}</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          {(["armed_home", "armed_away", "armed_night"] as const).map((m) => (
            <button key={m} className={`chip${state?.mode === m ? " active" : ""}`} onClick={() => void arm(m)}>
              {label(m)}
            </button>
          ))}
          {state && state.mode !== "disarmed" && (
            <button className="chip" onClick={async () => { await client.disarm(); reload(); }}>
              Disarm
            </button>
          )}
        </div>
      </div>

      {(cameras ?? []).length > 0 && <h2 className="section">Cameras</h2>}
      {active && (
        <div className="card">
          {active.mode === "webrtc" && active.webrtc ? (
            <WebRtcPlayer url={active.webrtc} onError={() => setActive((a) => (a ? { ...a, mode: "hls" } : a))} />
          ) : active.hls ? (
            <HlsPlayer url={active.hls} />
          ) : (
            <p className="muted">No playable stream.</p>
          )}
        </div>
      )}
      <div className="grid">
        {(cameras ?? []).map((c) => (
          <div key={c.id} className="tile" onClick={() => c.streamUrl && void play(c.id)} style={{ minHeight: 110 }}>
            {c.snapshotUrl && (
              <img
                src={c.snapshotUrl}
                alt={c.name}
                style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", opacity: 0.7 }}
              />
            )}
            <div className="label" style={{ position: "relative" }}>
              ▶ {c.name}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function label(mode: string): string {
  return mode === "armed_home"
    ? "Armed · Home"
    : mode === "armed_away"
      ? "Armed · Away"
      : mode === "armed_night"
        ? "Armed · Night"
        : "Disarmed";
}

// ── Energy ───────────────────────────────────────────────────────────────────
export function Energy() {
  const [summary, setSummary] = useState<EnergySummaryResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [devices] = useAsync<Device[]>(async () => (await client.devices()).devices);
  useEffect(() => {
    let live = true;
    client.energySummary().then((v) => { if (live) { setSummary(v); setLoaded(true); } }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, []);
  const deviceName = (id: string) => (devices ?? []).find((d) => d.id === id)?.name ?? "A device";
  const hasData = Boolean(summary && (summary.summary.length > 0 || summary.topConsumers.length > 0));
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="title">Energy</h1>
        <p className="sub">Where your home spends its power.</p>
      </div>
      {loaded && !hasData ? (
        <EmptyState icon="⚡" title="No energy data yet"
          hint="Once your home has metered devices reporting usage, you'll see where the power goes here — by device and over time." />
      ) : (
        <>
          {(summary?.summary ?? []).map((m) => (
            <div className="card row" key={m.measure}>
              <span style={{ textTransform: "capitalize" }}>{m.measure}</span>
              <strong>{Math.round(m.total)} {m.unit}</strong>
            </div>
          ))}
          {summary && summary.topConsumers.length > 0 && (
            <>
              <h2 className="section">Top consumers</h2>
              {summary.topConsumers.map((t) => (
                <div className="card row" key={t.deviceId}>
                  <span>{deviceName(t.deviceId)}</span>
                  <span className="muted">{Math.round(t.total)} {t.unit}</span>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
