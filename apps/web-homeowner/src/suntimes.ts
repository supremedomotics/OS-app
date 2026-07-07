/**
 * Local sunrise/sunset — a compact NOAA/SunCalc computation from latitude, longitude and date.
 * No network, no API key: real astronomy done on the device, so the home can say something warm and
 * true ("Sunset in 28 minutes") without asking anyone. Returns null near the poles where the sun
 * doesn't set.
 */
const rad = Math.PI / 180;
const dayMs = 86_400_000;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;

const toDays = (date: Date) => date.valueOf() / dayMs - 0.5 + J1970 - J2000;
const solarMeanAnomaly = (d: number) => rad * (357.5291 + 0.98560028 * d);
const eclipticLongitude = (M: number) => {
  const C = rad * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const P = rad * 102.9372;
  return M + C + P + Math.PI;
};
const declination = (L: number) => Math.asin(Math.sin(rad * 23.4397) * Math.sin(L));
const solarTransitJ = (ds: number, M: number, L: number) => J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
const hourAngle = (h: number, phi: number, dec: number) =>
  Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));

/** Sunset for the given location today (local time), or null if the sun doesn't set. */
export function sunset(lat: number, lon: number, date = new Date()): Date | null {
  const lw = rad * -lon;
  const phi = rad * lat;
  const d = toDays(date);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + (0 + lw) / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = declination(L);
  const w = hourAngle(rad * -0.833, phi, dec);
  if (Number.isNaN(w)) return null;
  const a = J0 + (w + lw) / (2 * Math.PI) + n;
  const Jset = solarTransitJ(a, M, L);
  if (Number.isNaN(Jset)) return null;
  return new Date((Jset + 0.5 - J1970) * dayMs);
}
