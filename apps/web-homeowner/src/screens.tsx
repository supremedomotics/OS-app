import { useEffect, useRef, useState } from "react";
import { Grid } from "@supreme/aureon-web";
import { useHeroFlip } from "./herotransition.js";
import { useAsync } from "./use-async.js";
import { FavHeart, useFavorites } from "./favorites.js";
import { recordUse, byFrequency } from "./usage.js";
import { friendlyError } from "./errors.js";
import { RoomChips } from "./roomchips.js";
import { EmptyState } from "./empty.js";
import type {
  HomeView,
  SecurityStateResponse,
} from "@supreme/contracts";
import type {
  CapabilityCommand,
  CapabilityKind,
  Device,
  DeviceId,
  RoomId,
  Scene,
} from "@supreme/domain-model";
import { client, fetchDriverRegistry } from "./api.js";
import { useRoomPhoto, styleForPhoto, ensureRoomHeroes, type RoomLike } from "./room-image.js";
import { useLive } from "./live.js";
import { LightingDetail } from "./lighting.js";
import { ClimateConsole } from "./climate-console.js";
import { ClimateSchedulerPage } from "./climate-scheduler-ui.js";
import { DeviceSheet } from "./device-sheets.js";
import { RemovableDeviceTile } from "./device-tile.js";
import { RoomLighting } from "./room-lighting.js";
import { useOpenDevice } from "./device-detail-router.js";
import { Icon } from "./icons.js";
import { LockCard } from "./features/security/card.js";
import { LockDetail } from "./features/security/lock-detail.js";
import { CameraCard } from "./features/security/camera-card.js";
import { CameraDetail } from "./features/security/camera-detail.js";
import { NvrDetail } from "./features/security/nvr-detail.js";
import { AlarmPanel } from "./features/security/alarm-panel.js";

export { useAsync } from "./use-async.js";

// ── Dashboard ──────────────────────────────────────────────────────────────────
function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Good night";
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  if (h < 21) return "Good evening";
  return "Good night";
}

/** A room tile: a real interior photo (hub-stored or fetched), else a designed motif gradient.
 * `onDelete`, when supplied (only from the Rooms management screen, never the Dashboard), shows
 * a small delete affordance in the corner — a room card is otherwise just a tap target. */
function RoomCard({ room, devices = [], onOpen, onDelete }: { room: RoomLike; devices?: Device[]; onOpen: (rect: DOMRect) => void; onDelete?: () => void }) {
  const photo = useRoomPhoto(room, client);
  const { emoji, ...style } = styleForPhoto(photo, room);
  return (
    <div className="room-card has-image" style={style} onClick={(e) => onOpen((e.currentTarget as HTMLElement).getBoundingClientRect())}>
      {emoji && <span className="room-motif" aria-hidden>{emoji}</span>}
      {onDelete && (
        <button className="room-card-delete" onClick={(e) => { e.stopPropagation(); onDelete(); }} aria-label={`Delete ${room.name}`}>
          ✕
        </button>
      )}
      <span className="name">{room.name}</span>
      <span className="room-card-sub"><RoomChips devices={devices} /></span>
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

      <Grid>
        {(home?.rooms ?? []).map((r) => (
          <RoomCard key={r.id} room={r} onOpen={() => onOpenRoom(r.id)} />
        ))}
      </Grid>
    </div>
  );
}

// ── Rooms ────────────────────────────────────────────────────────────────────
export function RoomsScreen({
  selected,
  onSelect,
  devMode = false,
}: {
  selected: string | null;
  onSelect: (roomId: string | null) => void;
  devMode?: boolean;
}) {
  const [home, refresh] = useAsync<HomeView>(() => client.home());
  const [allDevices] = useAsync<Device[]>(async () => (await client.devices()).devices);
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

  async function deleteRoom(room: RoomLike & { id: string }) {
    const count = (allDevices ?? []).filter((d) => d.roomId === room.id).length;
    const warn = count > 0 ? ` Its ${count} device${count === 1 ? "" : "s"} will become unassigned.` : "";
    if (!window.confirm(`Delete "${room.name}"?${warn}`)) return;
    try {
      await client.deleteRoom(room.id as never);
      setErr(null);
      refresh();
    } catch (e) {
      setErr(friendlyError(e, "Could not delete the room. Please try again."));
    }
  }

  if (selected) {
    const room = home?.rooms.find((r) => r.id === selected);
    return (
      <RoomCategories
        roomId={selected}
        name={room?.name ?? "Room"}
        heroImageUrl={room?.heroImageUrl ?? null}
        heroOrigin={heroOrigin.current}
        onBack={() => onSelect(null)}
        devMode={devMode}
      />
    );
  }

  return (
    <div>
      <div className="row" style={{ justifyContent: "space-between", alignItems: "center" }}>
        <h1 className="title">Rooms</h1>
        <button className="primary" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add room"}</button>
      </div>
      <p className="sub">Step into any room.</p>
      {adding && (
        <div className="card" style={{ marginBottom: 12 }}>
          <input placeholder="Room name (e.g. Home Gym)" value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && createRoom()} autoFocus />
          <button className="primary" disabled={!newName.trim()} onClick={createRoom} style={{ marginTop: 8 }}>Create room</button>
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <Grid>
        {/* Frequently-used rooms move higher (§ Personalization) — a stable order until the home has
            usage history, then the rooms you open most float to the top. */}
        {byFrequency(home?.rooms ?? [], "room").map((r) => (
          <RoomCard key={r.id} room={r} devices={(allDevices ?? []).filter((d) => d.roomId === r.id)}
            onOpen={(rect) => { heroOrigin.current = rect; recordUse("room", r.id); onSelect(r.id); }}
            onDelete={() => deleteRoom(r)} />
        ))}
      </Grid>
    </div>
  );
}

// ── Room navigation (§11.1): Room → control-type category → device list → individual control.
// A room is never a flat junk-drawer of every device type — you choose WHAT you're here to
// control first, exactly like a wall keypad is laid out zone by zone.
export type CategoryKind = "lighting" | "climate" | "media" | "curtains" | "security" | "fans" | "cleaning" | "other";
interface CategoryDef { kind: CategoryKind; label: string; icon: string }
const CATEGORY_DEFS: CategoryDef[] = [
  { kind: "lighting", label: "Lighting", icon: "☀" },
  { kind: "climate", label: "Climate", icon: "❄" },
  { kind: "media", label: "Media", icon: "♫" },
  { kind: "curtains", label: "Curtains & Blinds", icon: "▤" },
  { kind: "security", label: "Security", icon: "🔒" },
  { kind: "fans", label: "Fans", icon: "≋" },
  { kind: "cleaning", label: "Cleaning", icon: "◌" },
  { kind: "other", label: "Other", icon: "•" },
];

function categoryOf(caps: CapabilityKind[]): CategoryKind {
  if (caps.includes("brightness") || caps.includes("color")) return "lighting";
  if (caps.includes("temperature")) return "climate";
  if (caps.includes("media")) return "media";
  if (caps.includes("position")) return "curtains";
  if (caps.includes("lock")) return "security";
  if (caps.includes("fan")) return "fans";
  if (caps.includes("vacuum")) return "cleaning";
  return "other";
}

export function categorize(devices: Device[]): (CategoryDef & { devices: Device[] })[] {
  const buckets = new Map<CategoryKind, Device[]>();
  for (const d of devices) {
    const k = categoryOf(d.capabilities.map((c) => c.kind));
    buckets.set(k, [...(buckets.get(k) ?? []), d]);
  }
  return CATEGORY_DEFS.filter((c) => buckets.has(c.kind)).map((c) => ({ ...c, devices: buckets.get(c.kind)! }));
}

/** A short, live "what's happening" line per category — luxury communicates before you read further. */
function categorySummary(kind: CategoryKind, devices: Device[], live: Record<string, Record<string, unknown>>): string {
  const merged = (d: Device) => ({ ...d.state, ...live[d.id] }) as Record<string, Record<string, unknown> | undefined>;
  switch (kind) {
    case "lighting": {
      const on = devices.filter((d) => {
        const s = merged(d);
        return (s.brightness?.on ?? s.color?.on ?? s.onoff?.on) === true;
      }).length;
      return on > 0 ? `${on} of ${devices.length} on` : "All off";
    }
    case "curtains": {
      const open = devices.filter((d) => Number((merged(d).position as { position?: number } | undefined)?.position ?? 0) > 0).length;
      return open > 0 ? `${open} of ${devices.length} open` : "All closed";
    }
    case "climate": {
      if (devices.length === 1) {
        const t = merged(devices[0]!).temperature as { targetC?: number; ambientC?: number } | undefined;
        return t?.targetC != null ? `Set to ${Math.round(t.targetC)}°` : `${Math.round(t?.ambientC ?? 21)}° now`;
      }
      return `${devices.length} zones`;
    }
    case "media": {
      const playing = devices.filter((d) => (merged(d).media as { playback?: string } | undefined)?.playback === "playing").length;
      return playing > 0 ? `${playing} playing` : "Idle";
    }
    case "security": {
      const locked = devices.filter((d) => (merged(d).lock as { locked?: boolean } | undefined)?.locked !== false).length;
      return locked === devices.length ? "All locked" : `${devices.length - locked} unlocked`;
    }
    case "fans": {
      const on = devices.filter((d) => (merged(d).fan as { on?: boolean } | undefined)?.on).length;
      return on > 0 ? `${on} on` : "All off";
    }
    case "cleaning": {
      const active = devices.filter((d) => (merged(d).vacuum as { status?: string } | undefined)?.status === "cleaning").length;
      return active > 0 ? "Cleaning" : "Idle";
    }
    default: {
      const on = devices.filter((d) => (merged(d).onoff as { on?: boolean } | undefined)?.on).length;
      return on > 0 ? `${on} on` : "All off";
    }
  }
}

function RoomCategories({ roomId, name, heroImageUrl, heroOrigin, onBack, devMode = false }: { roomId: string; name: string; heroImageUrl: string | null; heroOrigin: DOMRect | null; onBack: () => void; devMode?: boolean }) {
  const heroRef = useHeroFlip<HTMLDivElement>(heroOrigin);
  const { refreshToken } = useOpenDevice();
  const [devices, reloadDevices] = useAsync<Device[]>(async () => (await client.devicesInRoom(roomId as RoomId)).devices, [roomId, refreshToken]);
  const { states } = useLive();
  const roomPhoto = useRoomPhoto({ id: roomId, name, heroImageUrl }, client);
  const [category, setCategory] = useState<CategoryKind | null>(null);
  const list = devices ?? [];
  const cats = categorize(list);

  if (category === "lighting") {
    const lights = cats.find((c) => c.kind === "lighting")?.devices ?? [];
    return <RoomLighting roomId={roomId} name={name} lights={lights} onBack={() => setCategory(null)} onDeviceRemoved={reloadDevices} devMode={devMode} />;
  }
  if (category) {
    const cat = cats.find((c) => c.kind === category);
    if (cat) return <CategoryDeviceList roomName={name} category={cat} onBack={() => setCategory(null)} onDeviceRemoved={reloadDevices} devMode={devMode} />;
  }

  return (
    <div>
      <button className="back" onClick={onBack}>‹ Rooms</button>
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
      <div className="cat-grid">
        {cats.map((c) => (
          <button key={c.kind} className="cat-card" onClick={() => setCategory(c.kind)}>
            <span className="cat-ic" aria-hidden>{c.icon}</span>
            <span className="cat-body">
              <span className="cat-lbl">{c.label}</span>
              <span className="cat-sub">{categorySummary(c.kind, c.devices, states)}</span>
            </span>
            <span className="cat-count">{c.devices.length}</span>
          </button>
        ))}
      </div>
      {devices && list.length === 0 && (
        <EmptyState icon="◎" title="This room is empty"
          hint="Devices you assign to this room will appear here. Add one from Discover Devices or move an existing device into this room." />
      )}
    </div>
  );
}

/** The device list for a single category (Media, Curtains, Climate, …) — tap a card to open its
 * full control. Lighting has its own richer page ({@link RoomLighting}); every other category
 * reuses the same tile grammar as the rest of the app. */
function CategoryDeviceList({ roomName, category, onBack, onDeviceRemoved, devMode = false }: { roomName: string; category: CategoryDef & { devices: Device[] }; onBack: () => void; onDeviceRemoved?: () => void; devMode?: boolean }) {
  const [detail, setDetail] = useState<Device | null>(null);
  const [climateId, setClimateId] = useState<string | null>(null);
  const [scheduleId, setScheduleId] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Device | null>(null);
  // § UI consistency rule: a device's detail page must be byte-identical no matter which
  // path opened it (Room > category > device, or the device's own dedicated whole-home
  // tab). Climate and Lighting each have a richer, capability-specific console
  // (ClimateConsole / LightingDetail) that the dedicated tabs already use — route to the
  // SAME component here instead of falling through to the generic DeviceSheet, which was
  // previously the fallback for every non-lighting capability including climate.
  const open = (d: Device) => {
    const caps = d.capabilities.map((c) => c.kind);
    if (caps.includes("brightness") || caps.includes("color")) setDetail(d);
    else if (caps.includes("temperature")) setClimateId(d.id);
    else setSheet(d);
  };
  const climate = climateId ? category.devices.find((d) => d.id === climateId) ?? null : null;
  const scheduling = scheduleId ? category.devices.find((d) => d.id === scheduleId) ?? null : null;
  if (detail) {
    return (
      <LightingDetail
        device={detail}
        onClose={() => setDetail(null)}
        onRemoved={() => { setDetail(null); onDeviceRemoved?.(); }}
        roomName={roomName}
        devMode={devMode}
      />
    );
  }
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
  if (climate) {
    return (
      <ClimateConsole
        device={climate}
        roomName={roomName}
        onBack={() => setClimateId(null)}
        onNavigateDevice={(d) => setClimateId(d.id)}
        onRemoved={() => { setClimateId(null); onDeviceRemoved?.(); }}
        onDeviceUpdated={() => onDeviceRemoved?.()}
        onOpenSchedule={(d) => setScheduleId(d.id)}
        devMode={devMode}
      />
    );
  }
  return (
    <div>
      <button className="back" onClick={onBack}>‹ {roomName}</button>
      <h1 className="title">{category.label}</h1>
      <div className="dlist">
        {category.devices.map((d) => (
          <RemovableDeviceTile key={d.id} device={d} onOpen={() => open(d)} onRemoved={onDeviceRemoved} />
        ))}
      </div>
      {sheet && (
        <DeviceSheet
          device={sheet}
          onClose={() => setSheet(null)}
          roomName={roomName}
          devMode={devMode}
          onRemoved={() => { setSheet(null); onDeviceRemoved?.(); }}
        />
      )}
    </div>
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
/**
 * The Security module's home (§ Premium Device Experience Library — Security Module: Lock,
 * Furniture Lock, Alarm, Camera, NVR, SIP Door Phone, Access Control). Alarm arm/disarm and
 * the camera grid were already here; Locks joins them as this module's third real, backend-
 * grounded slice — tapping a lock opens its Premium Detail Page ({@link LockDetail}), not a
 * quick sheet, matching how the Media tab opens AvrConsole/SimpleMediaDetail directly.
 */
export function Security({ devMode = false }: { devMode?: boolean } = {}) {
  const [state, reload] = useAsync<SecurityStateResponse>(() => client.securityState());
  const [cameras] = useAsync(async () => (await client.cameras()).cameras);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [registry] = useAsync(() => fetchDriverRegistry());
  const [selectedLockId, setSelectedLockId] = useState<string | null>(null);
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [nvrOpen, setNvrOpen] = useState(false);

  async function loadDevices() {
    const [devs, home] = await Promise.all([client.devices(), client.home()]);
    setDevices(devs.devices);
    setRooms(home.rooms.map((r) => ({ id: r.id, name: r.name })));
  }
  useEffect(() => { void loadDevices(); }, []);

  const locks = (devices ?? []).filter((d) => d.capabilities.some((c) => c.kind === "lock"));
  const roomName = (id: string | null | undefined) => rooms.find((r) => r.id === id)?.name ?? "Other";
  const selectedLock = selectedLockId ? locks.find((d) => d.id === selectedLockId) ?? null : null;
  const selectedCamera = selectedCameraId ? (cameras ?? []).find((c) => c.id === selectedCameraId) ?? null : null;

  if (selectedLock) {
    return (
      <LockDetail
        device={selectedLock}
        roomName={roomName(selectedLock.roomId)}
        onBack={() => setSelectedLockId(null)}
        onRemoved={() => { setSelectedLockId(null); void loadDevices(); }}
        onDeviceUpdated={(d) => setDevices((prev) => prev?.map((x) => (x.id === d.id ? d : x)) ?? prev)}
        allLocks={locks.filter((d) => d.id !== selectedLock.id)}
        devMode={devMode}
      />
    );
  }
  if (selectedCamera) {
    return (
      <CameraDetail
        camera={selectedCamera}
        roomName={roomName(selectedCamera.roomId)}
        onBack={() => setSelectedCameraId(null)}
      />
    );
  }
  if (nvrOpen) {
    return <NvrDetail cameras={cameras ?? []} onBack={() => setNvrOpen(false)} />;
  }

  async function arm(mode: "armed_home" | "armed_away" | "armed_night") {
    await client.arm(mode);
    reload();
  }

  return (
    <div>
      <h1 className="title">Security</h1>
      <AlarmPanel
        state={state}
        onArm={(m) => void arm(m)}
        onDisarm={() => { void client.disarm().then(reload); }}
      />

      {locks.length > 0 && <h2 className="section">Locks</h2>}
      {locks.length > 0 && (
        <Grid minItemWidth={260}>
          {locks.map((d) => {
            const driver = d.driverId ? registry?.find((r) => r.installedId === d.driverId || r.key === d.driverId) ?? null : null;
            const s = (d.state as Record<string, { locked?: boolean; jammed?: boolean }>).lock ?? {};
            const status = s.jammed ? "Jammed" : s.locked === false ? "Unlocked" : "Locked";
            return (
              <LockCard
                key={d.id}
                device={d}
                status={status}
                driverProtocol={driver?.protocols[0] ?? null}
                onOpen={() => setSelectedLockId(d.id)}
              />
            );
          })}
        </Grid>
      )}

      <div className="screen-head" style={{ marginBottom: 0 }}>
        <h2 className="section" style={{ margin: 0 }}>Cameras</h2>
        <button className="chip" onClick={() => setNvrOpen(true)}>🖥️ NVR</button>
      </div>
      <Grid>
        {(cameras ?? []).map((c) => (
          <CameraCard key={c.id} camera={c} onOpen={() => setSelectedCameraId(c.id)} />
        ))}
      </Grid>
    </div>
  );
}

