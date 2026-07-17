import { createContext, useContext, useEffect, useState } from "react";
import type { Device } from "@supreme/domain-model";
import type { DriverEntry } from "./api.js";
import { client, fetchDriverRegistry } from "./api.js";
import { LightingDetail } from "./lighting.js";
import { ClimateConsole } from "./climate-console.js";
import { ClimateSchedulerPage } from "./climate-scheduler-ui.js";
import { LockDetail } from "./features/security/lock-detail.js";
import { AvrConsole } from "./features/media/detail.js";
import { SimpleMediaDetail } from "./features/media/simple-detail.js";
import { mediaDeviceKind, usesSimpleMediaDetail } from "./features/media/capability-mapper.js";
import { EnergyDeviceDetail } from "./features/infrastructure/energy/detail.js";
import { isEnergyDevice } from "./features/infrastructure/energy/capability-mapper.js";
import { DeviceSheet } from "./device-sheets.js";

/**
 * Canonical Device Detail Router (§ Platform Architecture Rule — "Every device type must
 * have one canonical detail page... No page outside the router should ever import a
 * detail component directly. The router alone owns that responsibility.").
 *
 * Device Card → openDevice(deviceId) → CanonicalDeviceDetail → latest device fetch →
 * capability/type resolution (`resolveCanonicalDetail`) → canonical detail page.
 *
 * ONE overlay, owned at the app root (see `App.tsx`'s `openDeviceId` state), keyed purely
 * on `deviceId`. Every entry point that wants to open a device's detail page calls
 * {@link useOpenDevice}'s `openDevice(id)` instead of holding its own local "selected
 * device" state and rendering its own copy of a detail component. This component fetches
 * the device fresh from the SAME endpoints every caller already used (`client.devices()`,
 * `client.home()`, `fetchDriverRegistry()`), so no caller can hand it a stale, filtered, or
 * differently-shaped device object — the props reaching the canonical page are always
 * derived identically regardless of which screen triggered the open.
 *
 * Rich consoles: Lighting, Climate (+ its Schedule sub-page), Locks, Media (AVR console +
 * simple TV/projector page), Energy. Every OTHER capability set (curtains, blinds, fans,
 * sensors, water, generic "other") falls through to {@link DeviceSheet} — the canonical
 * fallback, owned here like every other detail component, never rendered directly by a
 * navigation page (§ Priority 2 — "DeviceSheet is itself a detail implementation and must
 * follow the same architecture"). Adding a dedicated rich console for one of these types
 * later means changing ONLY this file's dispatch order — no navigation page needs to know.
 *
 * NOT migrated — a real, disclosed gap, not silent:
 *   - Cameras/NVR (`client.cameras()`) — a fundamentally different data model, not indexed
 *     by `DeviceId` the way every other capability-bearing device is. Forcing it through
 *     `openDevice(deviceId: string)` would mean inventing a fake device-id mapping. See
 *     the Camera/NVR architecture recommendation in this session's report.
 *   - Scenes, Automations, Discovery Queue, Device Review Workspace — these aren't
 *     single-device detail pages at all (a scene is a set of actions, a discovery-queue
 *     item is a pre-commissioned candidate, not yet a `Device`).
 */

export interface DeviceDetailContextValue {
  openDevice: (deviceId: string) => void;
  /** Bumped whenever a device is removed or edited from the canonical detail page — any
   * screen that lists devices should include this in its data-loading effect's dependency
   * array so a change made from the canonical page is reflected everywhere, not just where
   * it was opened from. */
  refreshToken: number;
}

export const DeviceDetailContext = createContext<DeviceDetailContextValue>({ openDevice: () => {}, refreshToken: 0 });
export const useOpenDevice = () => useContext(DeviceDetailContext);

function isLight(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "brightness" || c.kind === "color");
}
function isClimate(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "temperature");
}
function isLock(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "lock");
}
function isMedia(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "media");
}

/** Everything {@link resolveCanonicalDetail} needs beyond the one device being opened —
 * fetched once by {@link CanonicalDeviceDetail} and handed down, never re-fetched
 * per-type. */
interface RouterContext {
  allDevices: Device[];
  roomName: string | undefined;
  registry: DriverEntry[] | undefined;
  devMode: boolean;
  onClose: () => void;
  onRemoved: () => void;
  openDevice: (id: string) => void;
  scheduleDevice: Device | null;
  setScheduleDevice: (d: Device | null) => void;
}

/** The ONE dispatch point for "which canonical component renders this device" — extend
 * this, and ONLY this, when another device type's canonical page joins the router. No
 * other file in the app may import LightingDetail, ClimateConsole, LockDetail, AvrConsole,
 * SimpleMediaDetail, or EnergyDeviceDetail — this function is their only caller. */
function resolveCanonicalDetail(device: Device, ctx: RouterContext) {
  if (ctx.scheduleDevice) {
    const config = (ctx.scheduleDevice.capabilities.find((c) => c.kind === "temperature")?.config ?? {}) as { modes?: string[]; fanSpeeds?: string[] };
    return (
      <ClimateSchedulerPage
        device={ctx.scheduleDevice}
        modes={config.modes ?? []}
        fanSpeeds={config.fanSpeeds ?? []}
        onBack={() => ctx.setScheduleDevice(null)}
      />
    );
  }

  if (isLight(device)) {
    return <LightingDetail device={device} roomName={ctx.roomName} devMode={ctx.devMode} onClose={ctx.onClose} onRemoved={ctx.onRemoved} />;
  }

  if (isClimate(device)) {
    return (
      <ClimateConsole
        device={device}
        roomName={ctx.roomName ?? "Other"}
        onBack={ctx.onClose}
        onNavigateDevice={(d) => ctx.openDevice(d.id)}
        onRemoved={ctx.onRemoved}
        onDeviceUpdated={ctx.onRemoved}
        onOpenSchedule={(d) => ctx.setScheduleDevice(d)}
        devMode={ctx.devMode}
      />
    );
  }

  if (isLock(device)) {
    return (
      <LockDetail
        device={device}
        roomName={ctx.roomName ?? "Other"}
        onBack={ctx.onClose}
        onRemoved={ctx.onRemoved}
        onDeviceUpdated={ctx.onRemoved}
        allLocks={ctx.allDevices.filter((d) => d.id !== device.id && isLock(d))}
        devMode={ctx.devMode}
      />
    );
  }

  if (isMedia(device)) {
    const driver = device.driverId ? ctx.registry?.find((r) => r.installedId === device.driverId || r.key === device.driverId) ?? null : null;
    const kind = mediaDeviceKind(device, driver?.protocols[0] ?? null);
    if (usesSimpleMediaDetail(kind)) {
      return (
        <SimpleMediaDetail device={device} roomName={ctx.roomName ?? "Other"} onBack={ctx.onClose} onRemoved={ctx.onRemoved} onDeviceUpdated={ctx.onRemoved} devMode={ctx.devMode} />
      );
    }
    return (
      <AvrConsole
        device={device}
        allDevices={ctx.allDevices.filter(isMedia)}
        homeDevices={ctx.allDevices}
        roomName={ctx.roomName ?? "Other"}
        onBack={ctx.onClose}
        onNavigateDevice={(d) => ctx.openDevice(d.id)}
        onRemoved={ctx.onRemoved}
        onDeviceUpdated={ctx.onRemoved}
        devMode={ctx.devMode}
      />
    );
  }

  if (isEnergyDevice(device)) {
    return <EnergyDeviceDetail device={device} roomName={ctx.roomName ?? "Other"} onBack={ctx.onClose} onRemoved={ctx.onRemoved} onDeviceUpdated={ctx.onRemoved} devMode={ctx.devMode} />;
  }

  // Canonical fallback (§ Priority 2) — curtains, blinds, fans, sensors, water, generic
  // "other" all land here today. Real gap: none of these has a dedicated rich console yet;
  // DeviceSheet is the honest, shared, non-duplicated answer until one exists.
  return <DeviceSheet device={device} roomName={ctx.roomName} devMode={ctx.devMode} onClose={ctx.onClose} onRemoved={ctx.onRemoved} />;
}

/** Renders at the app root, above whatever tab/page is active — an open device replaces
 * the current page content entirely (matching the existing full-screen detail convention
 * every page already used locally), keyed on `deviceId` alone. */
export function CanonicalDeviceDetail({ deviceId, devMode, onClose, onRemoved }: { deviceId: string; devMode: boolean; onClose: () => void; onRemoved: () => void }) {
  const { openDevice } = useOpenDevice();
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [allDevices, setAllDevices] = useState<Device[]>([]);
  const [roomName, setRoomName] = useState<string | undefined>(undefined);
  const [registry, setRegistry] = useState<DriverEntry[] | undefined>(undefined);
  const [scheduleDevice, setScheduleDevice] = useState<Device | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDevice(undefined);
    setScheduleDevice(null);
    void Promise.all([client.devices(), client.home(), fetchDriverRegistry().catch(() => undefined)]).then(([devs, home, reg]) => {
      if (cancelled) return;
      const found = devs.devices.find((d) => d.id === deviceId) ?? null;
      setDevice(found);
      setAllDevices(devs.devices);
      setRoomName(home.rooms.find((r) => r.id === found?.roomId)?.name);
      setRegistry(reg);
    });
    return () => { cancelled = true; };
  }, [deviceId]);

  if (device === undefined) return <div className="page" />;
  if (device === null) {
    // Removed/renamed out from under an open detail view (e.g. two tabs) — never render a
    // stale device, just return the caller to where they came from.
    onClose();
    return null;
  }
  return resolveCanonicalDetail(device, { allDevices, roomName, registry, devMode, onClose, onRemoved, openDevice, scheduleDevice, setScheduleDevice });
}
