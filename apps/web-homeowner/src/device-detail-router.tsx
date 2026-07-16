import { createContext, useContext, useEffect, useState } from "react";
import type { Device } from "@supreme/domain-model";
import { client } from "./api.js";
import { LightingDetail } from "./lighting.js";

/**
 * Canonical Device Detail Router (§ Platform Architecture Rule — "Every device type must
 * have one canonical detail page... every navigation path should simply navigate to that
 * canonical page with the device ID").
 *
 * ONE overlay, owned at the app root (see `App.tsx`'s `openDeviceId` state), keyed purely
 * on `deviceId`. Every entry point that wants to open a device's detail page calls
 * {@link useOpenDevice}'s `openDevice(id)` instead of holding its own local "selected
 * device" state and rendering its own copy of a detail component — the entry point that
 * hands off the id is a route, not a renderer. {@link CanonicalDeviceDetail} fetches the
 * device fresh from the SAME endpoint every caller already used (`client.devices()`), so
 * no caller can hand it a stale, filtered, or differently-shaped device object — the props
 * reaching the canonical page (e.g. {@link LightingDetail}) are always derived identically
 * regardless of which screen triggered the open.
 *
 * Only lighting is wired through this router so far — the KNX ETS + Discovery pipeline
 * work this session focused on lighting devices specifically, and generalizing every other
 * device type's canonical page (Climate, Media, Curtains, Locks, Cameras, …) through this
 * same mechanism is real follow-up work, not done here. Callers for those types are
 * untouched and keep their existing local rendering; `resolveCanonicalDetail` below is the
 * one place a future type gets added.
 */

export interface DeviceDetailContextValue {
  openDevice: (deviceId: string) => void;
  /** Bumped whenever a device is removed from the canonical detail page — any screen that
   * lists devices should include this in its data-loading effect's dependency array so a
   * removal made from the canonical page is reflected everywhere, not just where it was
   * opened from. */
  refreshToken: number;
}

export const DeviceDetailContext = createContext<DeviceDetailContextValue>({ openDevice: () => {}, refreshToken: 0 });
export const useOpenDevice = () => useContext(DeviceDetailContext);

function isLight(d: Device): boolean {
  return d.capabilities.some((c) => c.kind === "brightness" || c.kind === "color");
}

/** The one dispatch point for "which canonical component renders this device" — extend
 * this, and ONLY this, when another device type's canonical page joins the router. */
function resolveCanonicalDetail(device: Device, roomName: string | undefined, devMode: boolean, onClose: () => void, onRemoved: () => void) {
  if (isLight(device)) {
    return <LightingDetail device={device} roomName={roomName} devMode={devMode} onClose={onClose} onRemoved={onRemoved} />;
  }
  return null;
}

/** Renders at the app root, above whatever tab/page is active — an open device replaces
 * the current page content entirely (matching the existing full-screen detail convention
 * every page already used locally), keyed on `deviceId` alone. */
export function CanonicalDeviceDetail({ deviceId, devMode, onClose, onRemoved }: { deviceId: string; devMode: boolean; onClose: () => void; onRemoved: () => void }) {
  const [device, setDevice] = useState<Device | null | undefined>(undefined);
  const [roomName, setRoomName] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setDevice(undefined);
    void Promise.all([client.devices(), client.home()]).then(([devs, home]) => {
      if (cancelled) return;
      const found = devs.devices.find((d) => d.id === deviceId) ?? null;
      setDevice(found);
      setRoomName(home.rooms.find((r) => r.id === found?.roomId)?.name);
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
  return resolveCanonicalDetail(device, roomName, devMode, onClose, onRemoved);
}
