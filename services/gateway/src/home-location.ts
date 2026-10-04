import type { AppContext } from "./context.js";

/** The residence's place on Earth (§ the sun, schedules). Stored in the home config under
 * `location`; `lat`/`lon` are what sunrise/sunset need, `timeZone` and `label` are for display. */
export interface HomeLocation {
  lat: number;
  lon: number;
  timeZone: string | null;
  label: string | null;
  utcOffsetMinutes: number | null;
}

/** The zone's offset from UTC right now, in minutes (DST included); null for an unknown zone. */
export function utcOffsetMinutes(timeZone: string | null, at: Date = new Date()): number | null {
  if (!timeZone) return null;
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric",
        hour: "numeric", minute: "numeric", second: "numeric",
      }).formatToParts(at).map((p) => [p.type, p.value]),
    );
    const local = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
    return Math.round((local - Math.floor(at.getTime() / 1000) * 1000) / 60000);
  } catch {
    return null;
  }
}

/** What `GET /v1/home` reports: the stored location, else the one the Hub was started with
 * (`SUPREME_LATITUDE`/`SUPREME_LONGITUDE`/`SUPREME_TZ`), else null — never a guessed place. */
export async function readHomeLocation(ctx: AppContext): Promise<HomeLocation | null> {
  const s = (await ctx.homeConfig.get(ctx.homeId, "location")) as Partial<HomeLocation> | undefined;
  if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
    const tz = s.timeZone ?? null;
    return { lat: s.lat!, lon: s.lon!, timeZone: tz, label: s.label ?? null, utcOffsetMinutes: utcOffsetMinutes(tz) };
  }
  const { latitude, longitude, timeZone } = ctx.config;
  if (latitude != null && longitude != null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
    const tz = timeZone || null;
    return { lat: latitude, lon: longitude, timeZone: tz, label: null, utcOffsetMinutes: utcOffsetMinutes(tz) };
  }
  return null;
}
