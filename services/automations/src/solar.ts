/**
 * Solar schedule (§10) — sunrise / sunset / solar-noon for a location + date. The foundation for the
 * most-wanted automations ("turn the path lights on at sunset", "open the blinds at sunrise") and a
 * natural anchor for circadian keyframes. Pure + deterministic (no clock, no I/O): implements the
 * standard sunrise equation (NOAA), returning UTC instants.
 *
 * Validated against the equinox/equator vector (sun rises ~06:00 / sets ~18:00 UTC at lon 0) and the
 * obvious property that summer days are longer than winter days in the northern hemisphere.
 */

export interface SunTimes {
  /** UTC ISO instant of sunrise (geometric, with the standard -0.833° refraction altitude). */
  sunrise: string;
  sunset: string;
  solarNoon: string;
  /** Daylight length in minutes. */
  daylightMinutes: number;
  /** True at extreme latitudes/seasons where the sun never rises or never sets. */
  polarDayOrNight?: "day" | "night";
}

const deg = Math.PI / 180;
const J2000 = 2451545.0;

/** Julian day number at 00:00 UTC of the given date. */
function julianDay(year: number, month: number, day: number): number {
  // Fliegel–Van Flandern.
  const a = Math.floor((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
}

function julianToIso(jd: number): string {
  // JD → Unix epoch ms (JD 2440587.5 == 1970-01-01T00:00Z).
  const ms = (jd - 2440587.5) * 86400_000;
  return new Date(Math.round(ms)).toISOString();
}

/**
 * Sun times for a date (UTC year/month/day) at latitude/longitude in degrees (north +, east +).
 */
export function sunTimes(input: { year: number; month: number; day: number; latitude: number; longitude: number }): SunTimes {
  const { latitude: lat, longitude: lon } = input;
  const jdate = julianDay(input.year, input.month, input.day);
  const n = jdate - J2000 + 0.0008; // current Julian day since 2000 (+ leap-second offset)
  const Jstar = n - lon / 360; // mean solar noon (west-positive in the formula → -lon/360 for east+)
  const M = (357.5291 + 0.98560028 * Jstar) % 360;
  const Mr = M * deg;
  const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
  const lambda = (M + C + 180 + 102.9372) % 360;
  const lr = lambda * deg;
  const Jtransit = J2000 + Jstar + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * lr);
  const sinDec = Math.sin(lr) * Math.sin(23.4397 * deg);
  const cosDec = Math.cos(Math.asin(sinDec));
  const cosOmega = (Math.sin(-0.833 * deg) - Math.sin(lat * deg) * sinDec) / (Math.cos(lat * deg) * cosDec);

  const solarNoon = julianToIso(Jtransit);
  if (cosOmega < -1) return { sunrise: solarNoon, sunset: solarNoon, solarNoon, daylightMinutes: 1440, polarDayOrNight: "day" };
  if (cosOmega > 1) return { sunrise: solarNoon, sunset: solarNoon, solarNoon, daylightMinutes: 0, polarDayOrNight: "night" };

  const omega = Math.acos(cosOmega) / deg; // degrees
  const Jrise = Jtransit - omega / 360;
  const Jset = Jtransit + omega / 360;
  return {
    sunrise: julianToIso(Jrise),
    sunset: julianToIso(Jset),
    solarNoon,
    daylightMinutes: Math.round((Jset - Jrise) * 1440),
  };
}
