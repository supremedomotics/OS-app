import type { Device } from "@supreme/domain-model";

/**
 * A live, human summary of what's actually happening in a room — "3 lights · 1 media · Blinds 60%".
 * Counts every device that is ON by friendly category, and lists open covers with their position.
 * Homeowner language only (never capability kinds). Empty string when the room is at rest.
 */
type Caps = string[];
type State = Record<string, { on?: boolean; level?: number; position?: number; playback?: string; mode?: string } | undefined>;

function plural(n: number, word: string): string {
  const p = word === "switch" ? "switches" : `${word}s`;
  return `${n} ${n === 1 ? word : p}`;
}

export type ChipKind = "light" | "climate" | "media" | "fan" | "switch" | "cover";
export type RoomChip = { kind: ChipKind; label: string };

/** Structured, glyph-friendly summary — luxury communicates before you read (icons, then counts). */
export function roomChips(devices: Device[]): RoomChip[] {
  let lights = 0, climate = 0, media = 0, fans = 0, switches = 0;
  const coversOpen: number[] = [];
  for (const d of devices) {
    const caps = d.capabilities.map((c) => c.kind) as Caps;
    const st = (d.state ?? {}) as State;
    if (caps.includes("position")) { const p = Math.round(st.position?.position ?? 0); if (p > 0) coversOpen.push(p); continue; }
    if (caps.includes("brightness") || caps.includes("color")) { if (st.brightness?.on ?? st.color?.on ?? st.onoff?.on) lights++; continue; }
    if (caps.includes("temperature")) { const m = st.temperature?.mode; if (m && m !== "off") climate++; continue; }
    if (caps.includes("media")) { const pb = st.media?.playback; if (pb === "playing" || pb === "paused") media++; continue; }
    if (caps.includes("fan")) { if (st.fan?.on) fans++; continue; }
    if (caps.includes("onoff")) { if (st.onoff?.on) switches++; continue; }
  }
  const chips: RoomChip[] = [];
  if (lights) chips.push({ kind: "light", label: `${lights}` });
  if (climate) chips.push({ kind: "climate", label: `${climate}` });
  if (media) chips.push({ kind: "media", label: `${media}` });
  if (fans) chips.push({ kind: "fan", label: `${fans}` });
  if (switches) chips.push({ kind: "switch", label: `${switches}` });
  if (coversOpen.length === 1) chips.push({ kind: "cover", label: `${coversOpen[0]}%` });
  else if (coversOpen.length > 1) chips.push({ kind: "cover", label: `${coversOpen.length}` });
  return chips;
}

export function summarizeRoom(devices: Device[]): string {
  let lights = 0, climate = 0, media = 0, fans = 0, switches = 0;
  const coversOpen: number[] = [];

  for (const d of devices) {
    const caps = d.capabilities.map((c) => c.kind) as Caps;
    const st = (d.state ?? {}) as State;
    if (caps.includes("position")) {
      const p = Math.round(st.position?.position ?? 0);
      if (p > 0) coversOpen.push(p);
      continue;
    }
    if (caps.includes("brightness") || caps.includes("color")) {
      if (st.brightness?.on ?? st.color?.on ?? st.onoff?.on) lights++;
      continue;
    }
    if (caps.includes("temperature")) {
      const m = st.temperature?.mode;
      if (m && m !== "off") climate++;
      continue;
    }
    if (caps.includes("media")) {
      const pb = st.media?.playback;
      if (pb === "playing" || pb === "paused") media++;
      continue;
    }
    if (caps.includes("fan")) {
      if (st.fan?.on) fans++;
      continue;
    }
    if (caps.includes("onoff")) {
      if (st.onoff?.on) switches++;
      continue;
    }
  }

  const parts: string[] = [];
  if (lights) parts.push(plural(lights, "light"));
  if (climate) parts.push(`${climate} climate`);
  if (media) parts.push(plural(media, "player"));
  if (fans) parts.push(plural(fans, "fan"));
  if (switches) parts.push(plural(switches, "switch"));
  if (coversOpen.length === 1) parts.push(`blinds ${coversOpen[0]}%`);
  else if (coversOpen.length > 1) parts.push(`${coversOpen.length} blinds open`);
  return parts.join(" · ");
}
