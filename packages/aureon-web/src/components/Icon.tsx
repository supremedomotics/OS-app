import type { JSX } from "react";

/**
 * The one icon set for SupremeOS (§ Design System — Iconography). Consolidates what were three
 * independent, drifting systems: `icons.tsx`'s nav/category glyphs, `device-tile.tsx`'s
 * `DeviceIcon` (which had genuinely different path data for `light`/`fan`/`cover` than
 * `icons.tsx`'s versions of the same concepts), and ad hoc emoji scattered across ~10 files.
 * This is the merged, single source of truth; existing per-page icon components are left in
 * place until each page migrates onto this one (§ Implementation — do not break existing
 * functionality) so no page changes appearance in this pass.
 *
 * Adding an icon for a new device type is one entry in `PATHS` below — no new component, no
 * new file (§ Prepare SupremeOS for future device integrations).
 */
export type IconName =
  // Navigation / structural (from the former icons.tsx)
  | "home" | "rooms" | "scenes" | "security" | "settings"
  | "automations" | "energy" | "play" | "developer"
  | "dashboard" | "discover" | "devices" | "extensions" | "areas" | "notifications" | "media"
  // Device / capability glyphs
  | "light" | "climate" | "fan" | "cover" | "power"
  | "switch" | "sensor" | "lock-locked" | "lock-unlocked" | "vacuum"
  // § Premium Device Experience Library — one line-art family replacing emoji everywhere
  // (Security: Lock / Alarm / Camera / NVR; Media: Television / Projector / AVR / Speaker).
  | "shield-alert" | "lock-jammed" | "battery" | "user" | "clock" | "wifi" | "key" | "timer"
  | "door" | "briefcase" | "moon" | "siren" | "alert-triangle" | "clipboard" | "antenna"
  | "camera" | "expand" | "record" | "mic" | "sparkle" | "joystick" | "grid" | "calendar"
  | "monitor" | "database" | "target" | "heart" | "download" | "tv" | "projector" | "receiver"
  | "speaker" | "gamepad" | "volume" | "volume-mute" | "image" | "remote" | "film" | "music-note"
  | "apple-tv" | "cabinet";

const PATHS: Record<IconName, JSX.Element> = {
  home: <><path d="M3 10.7 12 3.5l9 7.2" /><path d="M5.6 9.6V20h12.8V9.6" /><path d="M10 20v-5h4v5" /></>,
  dashboard: <><rect x="3.5" y="3.5" width="7.5" height="9.5" rx="1.4" /><rect x="3.5" y="16" width="7.5" height="4.5" rx="1.4" /><rect x="13" y="3.5" width="7.5" height="4.5" rx="1.4" /><rect x="13" y="11" width="7.5" height="9.5" rx="1.4" /></>,
  discover: <><circle cx="11" cy="11" r="6.5" /><path d="M11 4.5v3M11 14.5v3M4.5 11h3M14.5 11h3" /><path d="M20.5 20.5 16 16" /></>,
  devices: <><rect x="3.5" y="5" width="12" height="14" rx="1.6" /><rect x="17" y="9" width="3.5" height="10" rx="1.2" /><path d="M6.5 8.5h6M6.5 12h6" /></>,
  extensions: <><path d="M9 3.5h3.2a1 1 0 0 1 1 1V6a1.6 1.6 0 0 0 3.2 0V4.5h2.1a1 1 0 0 1 1 1V8h1.4a1.6 1.6 0 0 1 0 3.2H20v3.3a1 1 0 0 1-1 1h-2.6" /><path d="M13.2 20.5H5.5a1 1 0 0 1-1-1v-6.8H6a1.6 1.6 0 0 0 0-3.2H4.5V4.5" /></>,
  rooms: <><rect x="3.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="3.5" width="7" height="7" rx="1.4" /><rect x="3.5" y="13.5" width="7" height="7" rx="1.4" /><rect x="13.5" y="13.5" width="7" height="7" rx="1.4" /></>,
  areas: <><path d="M3.5 8.5 12 4l8.5 4.5-8.5 4.5z" /><path d="M3.5 13 12 17.5 20.5 13" /><path d="M3.5 8.5v4.5M20.5 8.5v4.5" /></>,
  scenes: <><path d="M12 4.2l1.7 4.6 4.6 1.7-4.6 1.7L12 16.8l-1.7-4.6L5.7 10.5l4.6-1.7z" /><path d="M18.8 4v2.6M20.1 5.3h-2.6" /></>,
  security: <path d="M12 3.4l7 2.6v4.9c0 4.4-2.9 7.4-7 8.7-4.1-1.3-7-4.3-7-8.7V6z" />,
  settings: <><circle cx="12" cy="12" r="3.1" /><path d="M12 2.4v2.6M12 19v2.6M2.4 12H5M19 12h2.6M5.2 5.2 7 7M17 17l1.8 1.8M18.8 5.2 17 7M7 17l-1.8 1.8" /></>,
  automations: <><path d="M4.6 9.2a7.6 7.6 0 0 1 12.9-2.3" /><path d="M17.8 3.4V7h-3.6" /><path d="M19.4 14.8a7.6 7.6 0 0 1-12.9 2.3" /><path d="M6.2 20.6V17h3.6" /></>,
  energy: <path d="M12.7 3 5.5 13H10l-.8 8 8.3-11H13z" />,
  play: <path d="M7.5 5.5 18 12 7.5 18.5z" />,
  developer: <><path d="M8.5 8.5 5 12l3.5 3.5" /><path d="M15.5 8.5 19 12l-3.5 3.5" /><path d="M13.2 5l-2.4 14" /></>,
  notifications: <><path d="M6 9.5a6 6 0 0 1 12 0c0 4.2 1.2 5.7 2 6.6H4c.8-.9 2-2.4 2-6.6z" /><path d="M9.7 19.5a2.4 2.4 0 0 0 4.6 0" /></>,
  media: <><path d="M9 6.5v11l8.5-5.5z" /><circle cx="12" cy="12" r="9" /></>,
  light: <><path d="M9 18h6" /><path d="M10 21h4" /><path d="M8 11a4 4 0 1 1 8 0c0 1.7-1 2.6-1.6 3.4-.4.6-.4 1.1-.4 1.6h-4c0-.5 0-1-.4-1.6C9 13.6 8 12.7 8 11z" /></>,
  climate: <><path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" /><path d="M12 8v6.5" /></>,
  fan: <><circle cx="12" cy="12" r="1.6" /><path d="M12 10.4c0-3 .5-6.4-1.5-6.4S8 6 10.6 11" /><path d="M13.6 12c3 0 6.4.5 6.4-1.5S16 8 11 10.6" /><path d="M12 13.6c0 3-.5 6.4 1.5 6.4S16 18 13.4 13" /></>,
  cover: <><rect x="4.5" y="4" width="15" height="16" rx="1.4" /><path d="M4.5 8h15M4.5 12h15M4.5 16h15" /></>,
  power: <><path d="M12 3v9" /><path d="M6.5 7a7 7 0 1 0 11 0" /></>,
  // Merged in from device-tile.tsx's DeviceIcon — capabilities icons.tsx never covered.
  switch: <><path d="M8 6h8a5 5 0 0 1 0 10H8A5 5 0 0 1 8 6Z" /><circle cx="8" cy="11" r="3" /></>,
  sensor: <path d="M12 3v18M3 12h18" />,
  "lock-locked": <><path d="M5 11h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9Z" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
  "lock-unlocked": <><path d="M5 11h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9Z" /><path d="M8 11V7a4 4 0 0 1 7.5-2.5" /></>,
  vacuum: <><circle cx="12" cy="12" r="9" /><path d="M8 21h8M9 17v2M15 17v2" /></>,

  // § Premium Device Experience Library icon family — Security -----------------------------
  "shield-alert": <><path d="M12 3.4l7 2.6v4.9c0 4.4-2.9 7.4-7 8.7-4.1-1.3-7-4.3-7-8.7V6z" /><path d="M12 8.4v4.2" /><circle cx="12" cy="15.6" r="0.9" fill="currentColor" stroke="none" /></>,
  "lock-jammed": <><path d="M5 11h14v9a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-9Z" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /><path d="M9.3 14.3l5.4 5.4M14.7 14.3l-5.4 5.4" /></>,
  battery: <><rect x="2.5" y="8" width="16" height="8" rx="1.6" /><path d="M21 10.5v3" /><rect x="5" y="10.2" width="6" height="3.6" rx="0.6" fill="currentColor" stroke="none" /></>,
  user: <><circle cx="12" cy="8" r="3.4" /><path d="M5 20c0-3.6 3.1-6 7-6s7 2.4 7 6" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  wifi: <><path d="M4.5 9.3a11 11 0 0 1 15 0" /><path d="M7.4 12.8a7 7 0 0 1 9.2 0" /><path d="M10.2 16.2a3 3 0 0 1 3.6 0" /><circle cx="12" cy="19" r="0.9" fill="currentColor" stroke="none" /></>,
  key: <><circle cx="8" cy="15" r="3.6" /><path d="M10.4 12.6 18 5l1.6 1.6M16 7.4 18 9.4" /></>,
  timer: <><circle cx="12" cy="13" r="7.5" /><path d="M12 13V9M9.5 3.5h5" /></>,
  door: <><rect x="5.5" y="3" width="12" height="18" rx="1.2" /><circle cx="14.3" cy="12" r="0.9" fill="currentColor" stroke="none" /></>,
  briefcase: <><rect x="3" y="8" width="18" height="11.5" rx="1.6" /><path d="M8.5 8V6a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v2" /><path d="M3 13.2h18" /></>,
  moon: <path d="M19 13.5a7.5 7.5 0 1 1-8.5-9 6 6 0 0 0 8.5 9z" />,
  siren: <><path d="M6 13a6 6 0 0 1 12 0v5H6z" /><path d="M12 4.5V3M6.5 5.5l-1-1M17.5 5.5l1-1" /><path d="M4 21h16" /></>,
  "alert-triangle": <><path d="M12 3.5 21 19H3z" /><path d="M12 9.5V14" /><circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" /></>,
  clipboard: <><rect x="5.5" y="4.5" width="13" height="16" rx="1.6" /><rect x="9" y="3" width="6" height="3" rx="1" /><path d="M8.5 11h7M8.5 14.5h7M8.5 18h4.5" /></>,
  antenna: <><path d="M12 21V9" /><path d="M8 6.5a5.7 5.7 0 0 1 8 0M5.3 3.8a9.6 9.6 0 0 1 13.4 0" /><circle cx="12" cy="9" r="1.6" /></>,

  // § Premium Device Experience Library icon family — Camera / NVR --------------------------
  camera: <><rect x="3" y="7" width="14" height="11" rx="1.8" /><path d="M17 10.5 21 8v8l-4-2.5" /><circle cx="10" cy="12.5" r="2.6" /></>,
  expand: <path d="M9 4H4v5M15 4h5v5M4 15v5h5M20 15v5h-5" />,
  record: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0" /><path d="M12 17v4M9 21h6" /></>,
  sparkle: <><path d="M12 3l1.6 5.4L19 10l-5.4 1.6L12 17l-1.6-5.4L5 10l5.4-1.6z" /><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z" /></>,
  joystick: <><circle cx="12" cy="8" r="3.4" /><path d="M12 11.4V16" /><path d="M7 20.5h10" /><path d="M9.5 20.5 12 16l2.5 4.5" /></>,
  grid: <><circle cx="6" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="18" cy="6" r="1.3" fill="currentColor" stroke="none" /><circle cx="6" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.3" fill="currentColor" stroke="none" /><circle cx="6" cy="18" r="1.3" fill="currentColor" stroke="none" /><circle cx="12" cy="18" r="1.3" fill="currentColor" stroke="none" /><circle cx="18" cy="18" r="1.3" fill="currentColor" stroke="none" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15" rx="1.8" /><path d="M3.5 9.5h17" /><path d="M8 3v4M16 3v4" /></>,
  monitor: <><rect x="3" y="4.5" width="18" height="12" rx="1.6" /><path d="M9 20.5h6M12 16.5v4" /></>,
  database: <><ellipse cx="12" cy="5.5" rx="7.5" ry="2.5" /><path d="M4.5 5.5v13c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5v-13" /><path d="M4.5 12c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5" /></>,
  target: <><circle cx="12" cy="12" r="8" /><circle cx="12" cy="12" r="4.2" /><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none" /></>,
  heart: <path d="M12 20s-7.5-4.6-7.5-10A4.5 4.5 0 0 1 12 7a4.5 4.5 0 0 1 7.5 3c0 5.4-7.5 10-7.5 10z" />,
  download: <><path d="M12 3v12M8 11l4 4 4-4" /><path d="M4.5 17v2.5A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5V17" /></>,

  // § Premium Device Experience Library icon family — Media ----------------------------------
  tv: <><rect x="3" y="5" width="18" height="12.5" rx="1.8" /><path d="M9 21h6M12 17.5V21" /></>,
  projector: <><rect x="2.5" y="8" width="13" height="8" rx="1.8" /><circle cx="9" cy="12" r="2.6" /><path d="M15.5 10.5 21 8v8l-5.5-2.5" /><path d="M6 16v2M12 16v2" /></>,
  receiver: <><rect x="2.5" y="6" width="19" height="12" rx="1.8" /><circle cx="7.5" cy="12" r="2.1" /><path d="M12.5 9.5h6M12.5 12h6M12.5 14.5h4" /></>,
  speaker: <><rect x="6" y="2.5" width="12" height="19" rx="2.4" /><circle cx="12" cy="8" r="1.8" /><circle cx="12" cy="15" r="3.4" /></>,
  "apple-tv": <><rect x="4" y="7" width="16" height="10" rx="2.2" /><path d="M10.5 10.2v3.6l3-1.8Z" fill="currentColor" stroke="none" /></>,
  gamepad: <><path d="M7 8.5h10a4.5 4.5 0 0 1 4.4 5.5l-.6 2.4a2.4 2.4 0 0 1-4.3.8L15 15.5H9l-1.5 1.7a2.4 2.4 0 0 1-4.3-.8l-.6-2.4A4.5 4.5 0 0 1 7 8.5Z" /><path d="M8 11v3M6.5 12.5h3" /><circle cx="16" cy="11.5" r="0.7" fill="currentColor" stroke="none" /><circle cx="18" cy="13.5" r="0.7" fill="currentColor" stroke="none" /></>,
  volume: <><path d="M4 10v4h3.5L12 17.5v-11L7.5 10Z" /><path d="M16 9.5a4 4 0 0 1 0 5.6M18.5 7a7.5 7.5 0 0 1 0 10.6" /></>,
  "volume-mute": <><path d="M4 10v4h3.5L12 17.5v-11L7.5 10Z" /><path d="M16.5 10.5 20.5 14.5M20.5 10.5 16.5 14.5" /></>,
  image: <><rect x="3" y="4.5" width="18" height="15" rx="1.8" /><circle cx="8.3" cy="9.3" r="1.6" /><path d="M4 17l5.5-5.5L13 15l3-3 4 4.5" /></>,
  remote: <><rect x="7" y="2.5" width="10" height="19" rx="3.5" /><circle cx="12" cy="8" r="1.6" /><path d="M9.5 13h5M9.5 16.5h5" /></>,
  film: <><rect x="3" y="4.5" width="18" height="15" rx="1.6" /><path d="M8 4.5v15M16 4.5v15" /><path d="M3 9h5M16 9h5M3 15h5M16 15h5" /></>,
  "music-note": <><path d="M9 18a3 3 0 1 1 0-6 3 3 0 0 1 0 6Z" /><path d="M12 15V4.5l7-1.5v11" /></>,
  cabinet: <><rect x="5" y="2.5" width="14" height="19" rx="1.4" /><path d="M5 12h14" /><circle cx="9.5" cy="7.2" r="0.8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="16.8" r="0.8" fill="currentColor" stroke="none" /></>,
};

export interface IconProps {
  name: IconName;
  size?: number;
  /** Renders in the gold "active/on" tint (§ Design System — State Colors) instead of
   * inheriting the surrounding text color. */
  on?: boolean;
}

export function Icon({ name, size = 22, on = false }: IconProps) {
  return (
    <svg
      className={`aureon-icon${on ? " aureon-icon--on" : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
    >
      {PATHS[name]}
    </svg>
  );
}

/** Resolve the right device-type icon from a Supreme capability list, the same decision
 * `device-tile.tsx`'s `DeviceTile` makes inline today — centralized here so every future list
 * (Devices, room categories, the Inspector, …) picks the same icon for the same device without
 * re-deriving this priority order itself. */
export function iconForCapabilities(capabilities: readonly string[]): IconName {
  if (capabilities.includes("brightness")) return "light";
  if (capabilities.includes("position")) return "cover";
  if (capabilities.includes("lock")) return "lock-locked";
  if (capabilities.includes("fan")) return "fan";
  if (capabilities.includes("vacuum")) return "vacuum";
  if (capabilities.includes("media")) return "media";
  if (capabilities.includes("temperature")) return "climate";
  if (capabilities.includes("sensor")) return "sensor";
  return "switch";
}
