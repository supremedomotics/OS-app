import { useEffect, useRef, useState } from "react";
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
import { useLive } from "./live.js";
import { LightingDetail } from "./lighting.js";
import { HlsPlayer, WebRtcPlayer } from "./players.js";

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
export function Dashboard({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const [home] = useAsync<HomeView>(() => client.home());
  const [scenes] = useAsync<Scene[]>(async () => (await client.scenes()).scenes);

  const rooms = home?.rooms ?? [];
  const heroImage = rooms.find((r) => r.heroImageUrl)?.heroImageUrl ?? null;

  return (
    <div>
      <p className="sub">Welcome home</p>
      <h1 className="title">{home?.home.name ?? "Home"}</h1>

      {/* Ovio-style home hero: photographic backdrop → accent gradient fallback. */}
      <div
        className="hero"
        style={heroImage ? { backgroundImage: `linear-gradient(transparent 40%, rgba(0,0,0,0.62)), url(${heroImage})` } : undefined}
      >
        <div className="hero-top">{home?.home.name ?? "Home"}</div>
        <div className="hero-stats">
          <div>
            <strong>All calm</strong>
            <span>Home</span>
          </div>
          <div className="right">
            <strong>{rooms.length}</strong>
            <span>Rooms</span>
          </div>
        </div>
      </div>

      {/* Calm category aggregates (no long entity lists). */}
      <div className="cat-tiles">
        <div className="cat-tile">
          <span className="ic">▦</span>
          <span className="lbl">Rooms</span>
          <span className="v">{rooms.length}</span>
        </div>
        <div className="cat-tile">
          <span className="ic">✦</span>
          <span className="lbl">Scenes</span>
          <span className="v">{scenes?.length ?? 0}</span>
        </div>
      </div>

      {scenes && scenes.length > 0 && (
        <>
          <h2 className="section">Scenes</h2>
          <div className="scene-row">
            {scenes.map((s) => (
              <button key={s.id} className="scene-btn" onClick={() => void client.activateScene(s.id)}>
                {s.icon ? `${s.icon} ` : ""}
                {s.name}
              </button>
            ))}
          </div>
        </>
      )}

      <h2 className="section">Rooms</h2>
      <div className="grid">
        {(home?.rooms ?? []).map((r) => (
          <div
            key={r.id}
            className={`room-card${r.heroImageUrl ? " has-image" : ""}`}
            style={
              r.heroImageUrl
                ? { backgroundImage: `linear-gradient(transparent, rgba(0,0,0,0.7)), url(${r.heroImageUrl})` }
                : undefined
            }
            onClick={() => onOpenRoom(r.id)}
          >
            <span className="name">{r.name}</span>
          </div>
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
  const [home] = useAsync<HomeView>(() => client.home());

  if (selected) {
    const room = home?.rooms.find((r) => r.id === selected);
    return (
      <RoomDevices
        roomId={selected}
        name={room?.name ?? "Room"}
        heroImageUrl={room?.heroImageUrl ?? null}
        onBack={() => onSelect(null)}
      />
    );
  }

  return (
    <div>
      <h1 className="title">Rooms</h1>
      <p className="sub">Choose a room to control.</p>
      <div className="grid">
        {(home?.rooms ?? []).map((r) => (
          <div key={r.id} className="room-card" onClick={() => onSelect(r.id)}>
            <span className="name">{r.name}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RoomDevices({ roomId, name, heroImageUrl, onBack }: { roomId: string; name: string; heroImageUrl: string | null; onBack: () => void }) {
  const [devices] = useAsync<Device[]>(async () => (await client.devicesInRoom(roomId as RoomId)).devices, [roomId]);
  const [detail, setDetail] = useState<Device | null>(null);
  const list = devices ?? [];
  if (detail) return <LightingDetail device={detail} onClose={() => setDetail(null)} />;
  return (
    <div>
      <button className="back" onClick={onBack}>
        ‹ Rooms
      </button>
      {/* Room hero — entering a room should feel like entering the space. */}
      <div
        className="hero room"
        style={heroImageUrl ? { backgroundImage: `linear-gradient(transparent 45%, rgba(0,0,0,0.66)), url(${heroImageUrl})` } : undefined}
      >
        <div className="hero-top">{name}</div>
        <div className="hero-stats">
          <div>
            <strong>{list.length}</strong>
            <span>{list.length === 1 ? "device" : "devices"}</span>
          </div>
        </div>
      </div>
      <div className="dlist">
        {list.map((d) => (
          <DeviceTile key={d.id} device={d} onOpen={() => { if (d.capabilities.some((c) => c.kind === "brightness" || c.kind === "color")) setDetail(d); }} />
        ))}
      </div>
      {devices && list.length === 0 && <p className="muted">No devices in this room yet.</p>}
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
      onClick={slidable ? undefined : toggle}
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
  const [scenes] = useAsync<Scene[]>(async () => (await client.scenes()).scenes);
  const [order, setOrder] = useState<string[]>([]);
  const [edit, setEdit] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

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
        <button className={`edit-btn${edit ? " on" : ""}`} onClick={() => (edit ? save() : setEdit(true))}>
          {edit ? "Save" : "Edit"}
        </button>
      </div>

      <div className="scene-grid">
        {ordered.map((s) => (
          <div
            key={s.id}
            className={`scene-card${edit ? " editing" : ""}${dragId === s.id ? " dragging" : ""}`}
            draggable={edit}
            onDragStart={() => setDragId(s.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => { if (edit && dragId && dragId !== s.id) { e.preventDefault(); move(dragId, s.id); } }}
            onClick={() => {
              if (edit) return;
              void client.activateScene(s.id);
              setMsg(`${s.name} activated`);
            }}
          >
            <span className="play">{edit ? "⠿" : s.icon ? s.icon : "▷"}</span>
            <span className="nm">{s.name}</span>
          </div>
        ))}
      </div>
      {edit && <p className="muted">Drag the cards to reorder, then Save.</p>}
      {!edit && msg && <p className="muted">{msg}</p>}
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
  const [summary] = useAsync<EnergySummaryResponse>(() => client.energySummary());
  return (
    <div>
      <h1 className="title">Energy</h1>
      <p className="sub">Where your home spends its power.</p>
      {(summary?.summary ?? []).map((m) => (
        <div className="card row" key={m.measure}>
          <span style={{ textTransform: "capitalize" }}>{m.measure}</span>
          <strong>
            {Math.round(m.total)} {m.unit}
          </strong>
        </div>
      ))}
      {summary && summary.topConsumers.length > 0 && (
        <>
          <h2 className="section">Top consumers</h2>
          {summary.topConsumers.map((t) => (
            <div className="card row" key={t.deviceId}>
              <span className="muted">{t.deviceId}</span>
              <span>
                {Math.round(t.total)} {t.unit}
              </span>
            </div>
          ))}
        </>
      )}
      {summary && summary.summary.length === 0 && <p className="muted">No energy data yet.</p>}
    </div>
  );
}
