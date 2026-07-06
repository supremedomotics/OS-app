import { useEffect, useState } from "react";

/**
 * Weather (§ Home Dashboard → Weather) — real local conditions from Open-Meteo, a free keyless
 * forecast service. This is a CLIENT-SIDE concern: the homeowner's browser fetches Open-Meteo
 * directly, so it touches no gateway/backend and invents no data. Location is a local preference
 * (defaulting to a sensible home coordinate) that the owner can replace with their device location.
 */
export type GeoLoc = { lat: number; lon: number; label: string };
const LOC_KEY = "supreme.location";
// Default home coordinate — overridable via "Use my location" or a saved preference.
const DEFAULT_LOC: GeoLoc = { lat: 19.076, lon: 72.8777, label: "Home" };

export function loadLocation(): GeoLoc {
  try { return { ...DEFAULT_LOC, ...JSON.parse(localStorage.getItem(LOC_KEY) ?? "{}") }; }
  catch { return DEFAULT_LOC; }
}
function saveLocation(l: GeoLoc): void { localStorage.setItem(LOC_KEY, JSON.stringify(l)); }

export type Weather = { tempC: number; humidity: number; code: number; unit: string };

// WMO weather-interpretation codes → a homeowner-friendly label + a simple glyph (no icon asset).
function describe(code: number): { label: string; glyph: string } {
  if (code === 0) return { label: "Clear", glyph: "☀" };
  if (code <= 2) return { label: "Partly cloudy", glyph: "⛅" };
  if (code === 3) return { label: "Overcast", glyph: "☁" };
  if (code <= 48) return { label: "Fog", glyph: "🌫" };
  if (code <= 57) return { label: "Drizzle", glyph: "🌦" };
  if (code <= 67) return { label: "Rain", glyph: "🌧" };
  if (code <= 77) return { label: "Snow", glyph: "🌨" };
  if (code <= 82) return { label: "Showers", glyph: "🌦" };
  if (code <= 86) return { label: "Snow showers", glyph: "🌨" };
  return { label: "Thunderstorm", glyph: "⛈" };
}

async function fetchWeather(loc: GeoLoc): Promise<Weather> {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}`
    + `&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const j = await res.json() as { current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number }; current_units: { temperature_2m: string } };
  return { tempC: j.current.temperature_2m, humidity: j.current.relative_humidity_2m, code: j.current.weather_code, unit: j.current_units.temperature_2m };
}

/** A calm weather chip for the dashboard. Renders nothing on error so a failed fetch never adds noise. */
export function WeatherCard() {
  const [loc, setLoc] = useState<GeoLoc>(loadLocation);
  const [w, setW] = useState<Weather | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false);
    fetchWeather(loc).then((res) => { if (live) setW(res); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [loc]);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { const next = { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), label: "My location" }; saveLocation(next); setLoc(next); },
      () => { /* denied — keep current location */ },
      { timeout: 8000 },
    );
  }

  if (failed) return null;
  const d = w ? describe(w.code) : null;
  return (
    <button className="weather-card" onClick={useMyLocation} title="Use my location">
      <span className="weather-glyph" aria-hidden>{d?.glyph ?? "…"}</span>
      <span className="weather-meta">
        <span className="weather-temp">{w ? `${Math.round(w.tempC)}${w.unit}` : "—"}</span>
        <span className="weather-sub">{d ? `${d.label} · ${loc.label}` : "Loading weather…"}</span>
      </span>
      {w && <span className="weather-hum">{w.humidity}%</span>}
    </button>
  );
}
