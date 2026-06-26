import { useEffect, useState } from "react";
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
            className="room-card"
            style={
              r.heroImageUrl
                ? { backgroundImage: `linear-gradient(transparent, rgba(0,0,0,0.7)), url(${r.heroImageUrl})`, backgroundSize: "cover" }
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
    return <RoomDevices roomId={selected} name={room?.name ?? "Room"} onBack={() => onSelect(null)} />;
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

function RoomDevices({ roomId, name, onBack }: { roomId: string; name: string; onBack: () => void }) {
  const [devices] = useAsync<Device[]>(async () => (await client.devicesInRoom(roomId as RoomId)).devices, [roomId]);
  return (
    <div>
      <button className="back" onClick={onBack}>
        ‹ Rooms
      </button>
      <h1 className="title">{name}</h1>
      <div className="grid" style={{ marginTop: 12 }}>
        {(devices ?? []).map((d) => (
          <DeviceTile key={d.id} device={d} />
        ))}
      </div>
      {devices && devices.length === 0 && <p className="muted">No devices in this room yet.</p>}
    </div>
  );
}

// ── Device tile (tap-as-control; fill = level) ─────────────────────────────────
function DeviceTile({ device }: { device: Device }) {
  const { states, apply } = useLive();
  const live = states[device.id] ?? {};
  const caps = device.capabilities.map((c) => c.kind);
  const merged = { ...device.state, ...live } as Record<string, { on?: boolean; level?: number; value?: number; unit?: string }>;
  const isDimmer = caps.includes("brightness");
  const isSwitch = !isDimmer && caps.includes("onoff");
  const isSensor = !isDimmer && !isSwitch && caps.includes("sensor");

  const bright = merged.brightness;
  const onoff = merged.onoff;
  const on = bright?.on ?? onoff?.on ?? false;
  const level = bright?.level ?? (on ? 100 : 0);

  async function toggle() {
    const next = !on;
    apply(device.id, isDimmer ? "brightness" : "onoff", isDimmer ? { kind: "brightness", on: next, level: next ? Math.max(level, 1) : 0 } : { kind: "onoff", on: next });
    await client.command(device.id as DeviceId, { capability: "onoff", action: "toggle" } as CapabilityCommand);
  }
  async function setLevel(v: number) {
    apply(device.id, "brightness", { kind: "brightness", on: v > 0, level: v });
    await client.command(device.id as DeviceId, { capability: "brightness", action: "set", level: v } as CapabilityCommand);
  }

  if (isSensor) {
    const s = merged.sensor;
    return (
      <div className="tile">
        <div className="label">{device.name}</div>
        <div className="val">
          {s?.value ?? "—"} {s?.unit ?? ""}
        </div>
      </div>
    );
  }

  return (
    <div className={`tile${on ? " on" : ""}`} onClick={isDimmer ? undefined : toggle}>
      <div className="fill" style={{ width: `${isDimmer ? level : on ? 100 : 0}%` }} />
      <div className="label">{device.name}</div>
      {isDimmer ? (
        <input
          type="range"
          min={0}
          max={100}
          value={level}
          onChange={(e) => void setLevel(Number(e.target.value))}
        />
      ) : (
        <div className="val">{on ? "On" : "Off"}</div>
      )}
    </div>
  );
}

// ── Scenes ───────────────────────────────────────────────────────────────────
export function Scenes() {
  const [scenes] = useAsync<Scene[]>(async () => (await client.scenes()).scenes);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <div>
      <h1 className="title">Scenes</h1>
      <p className="sub">One tap to set the mood.</p>
      {(scenes ?? []).map((s) => (
        <div className="card row" key={s.id}>
          <strong>
            {s.icon ? `${s.icon} ` : ""}
            {s.name}
          </strong>
          <button
            className="primary"
            onClick={async () => {
              await client.activateScene(s.id);
              setMsg(`${s.name} activated`);
            }}
          >
            Activate
          </button>
        </div>
      ))}
      {msg && <p className="muted">{msg}</p>}
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
