import { useRef } from "react";
import type { CapabilityCommand, Device, DeviceId } from "@supreme/domain-model";
import { client } from "./api.js";
import { useLive } from "./live.js";
import { recordUse } from "./usage.js";

/**
 * Ovio "tile-as-control" (§11.1): a horizontal tile whose fill = value. Tap toggles on/off (the
 * fast, primary gesture); drag sets the level live with the value shown; a small chevron opens
 * the device's full detail — three distinct, unambiguous gestures instead of overloading tap.
 * Shared by every device list in the app (room categories, the lighting page, discovery, …) so the
 * behaviour is identical everywhere a device is one of these tiles.
 */
export function DeviceTile({ device, onOpen }: { device: Device; onOpen?: () => void }) {
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
    if (isDimmer) {
      apply(device.id, "brightness", { kind: "brightness", on: next, level: next ? Math.max(level, 1) : 0 });
      await client.command(device.id as DeviceId, { capability: "brightness", action: next ? "on" : "off" } as CapabilityCommand);
    } else if (isCover) {
      apply(device.id, "position", { kind: "position", position: next ? 100 : 0, moving: false });
      await client.command(device.id as DeviceId, { capability: "position", action: next ? "open" : "close" } as CapabilityCommand);
    } else {
      apply(device.id, "onoff", { kind: "onoff", on: next });
      await client.command(device.id as DeviceId, { capability: "onoff", action: "toggle" } as CapabilityCommand);
    }
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
      onClick={slidable ? undefined : () => void toggle()}
      onPointerDown={slidable ? (e) => { dragging.current = true; moved.current = false; (e.target as HTMLElement).setPointerCapture?.(e.pointerId); } : undefined}
      onPointerMove={slidable ? (e) => { if (dragging.current) { moved.current = true; fromClientX(e.clientX); } } : undefined}
      onPointerUp={slidable ? () => { dragging.current = false; if (!moved.current) void toggle(); } : undefined}
    >
      <div className="fill" style={{ width: `${level}%` }} />
      <DeviceIcon kind={isDimmer ? "light" : isCover ? "cover" : "switch"} on={on} />
      <span className="nm">{device.name}</span>
      <span className="rv">{slidable ? `${Math.round(level)}%` : on ? "On" : "Off"}</span>
      {onOpen && (
        <button
          className="dtile-open"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); onOpen(); }}
          aria-label={`Open ${device.name} details`}
        >
          ›
        </button>
      )}
    </div>
  );
}

/** Minimal Aureon line icons (monochrome, theme-aware via currentColor). */
export function DeviceIcon({ kind, on }: { kind: "light" | "cover" | "switch" | "sensor"; on: boolean }) {
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
