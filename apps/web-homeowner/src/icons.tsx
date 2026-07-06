/**
 * Inline line icons (Ovio style) that inherit `currentColor` — so they take the theme accent instead
 * of an emoji's fixed colour. One tiny component, no dependency, crisp at any size.
 */
type IconName =
  | "home" | "rooms" | "scenes" | "security" | "settings"
  | "automations" | "energy" | "play" | "developer"
  | "dashboard" | "discover" | "devices" | "extensions" | "areas" | "notifications";

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
};

export function Icon({ name, size = 22 }: { name: IconName; size?: number }) {
  return (
    <svg
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
