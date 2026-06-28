import { describe, expect, it } from "vitest";
import { sunTimes } from "./solar.js";

const minutesUtc = (iso: string) => {
  const d = new Date(iso);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
};

describe("sunTimes", () => {
  it("at the equator on the March equinox the sun rises ~06:00 and sets ~18:00 UTC (lon 0)", () => {
    // Tolerance ±15 min absorbs the equation of time (~+7 min on this date) + the -0.833°
    // refraction altitude; a wrong algorithm would be off by hours, not minutes.
    const t = sunTimes({ year: 2026, month: 3, day: 20, latitude: 0, longitude: 0 });
    expect(Math.abs(minutesUtc(t.sunrise) - 6 * 60)).toBeLessThanOrEqual(15);
    expect(Math.abs(minutesUtc(t.sunset) - 18 * 60)).toBeLessThanOrEqual(15);
    expect(Math.abs(minutesUtc(t.solarNoon) - 12 * 60)).toBeLessThanOrEqual(15);
    expect(Math.abs(t.daylightMinutes - 720)).toBeLessThanOrEqual(20); // ~12h ± refraction
  });

  it("orders sunrise < solar noon < sunset", () => {
    const t = sunTimes({ year: 2026, month: 6, day: 21, latitude: 40.7, longitude: -74 }); // NYC, summer
    expect(new Date(t.sunrise).getTime()).toBeLessThan(new Date(t.solarNoon).getTime());
    expect(new Date(t.solarNoon).getTime()).toBeLessThan(new Date(t.sunset).getTime());
  });

  it("northern-hemisphere summer days are longer than winter days", () => {
    const summer = sunTimes({ year: 2026, month: 6, day: 21, latitude: 51.5, longitude: 0 }); // London
    const winter = sunTimes({ year: 2026, month: 12, day: 21, latitude: 51.5, longitude: 0 });
    expect(summer.daylightMinutes).toBeGreaterThan(winter.daylightMinutes);
    expect(summer.daylightMinutes).toBeGreaterThan(900); // > 15h in midsummer London
    expect(winter.daylightMinutes).toBeLessThan(540); // < 9h in midwinter London
  });

  it("flags polar day inside the Arctic Circle at midsummer", () => {
    const t = sunTimes({ year: 2026, month: 6, day: 21, latitude: 78, longitude: 15 }); // Svalbard
    expect(t.polarDayOrNight).toBe("day");
    expect(t.daylightMinutes).toBe(1440);
  });
});
