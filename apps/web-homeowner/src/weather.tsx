import { useEffect, useRef, useState } from "react";

/**
 * Weather (§ Home Dashboard → Weather) — real local conditions + hourly forecast from Open-Meteo, a
 * free keyless service, with a proper city picker backed by Open-Meteo's geocoding API. This is a
 * CLIENT-SIDE concern: the homeowner's browser talks to Open-Meteo directly, so it touches no
 * gateway/backend and invents no data. Location is a local preference (a chosen city or the device
 * location), defaulting to a sensible home coordinate.
 */
export type GeoLoc = { lat: number; lon: number; label: string };
const LOC_KEY = "supreme.location";
const DEFAULT_LOC: GeoLoc = { lat: 19.076, lon: 72.8777, label: "Home" };

export function loadLocation(): GeoLoc {
  try { return { ...DEFAULT_LOC, ...JSON.parse(localStorage.getItem(LOC_KEY) ?? "{}") }; }
  catch { return DEFAULT_LOC; }
}
function saveLocation(l: GeoLoc): void { localStorage.setItem(LOC_KEY, JSON.stringify(l)); }

export type Hour = { time: string; tempC: number; code: number };
export type Weather = { tempC: number; humidity: number; code: number; unit: string; hourly: Hour[] };
export type City = { name: string; lat: number; lon: number; label: string };

// WMO weather-interpretation codes → a homeowner-friendly label + a simple glyph (no icon asset).
export function describe(code: number): { label: string; glyph: string } {
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
    + `&current=temperature_2m,relative_humidity_2m,weather_code`
    + `&hourly=temperature_2m,weather_code&forecast_days=2&timezone=auto`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`weather ${res.status}`);
  const j = await res.json() as {
    current: { temperature_2m: number; relative_humidity_2m: number; weather_code: number };
    current_units: { temperature_2m: string };
    hourly: { time: string[]; temperature_2m: number[]; weather_code: number[] };
  };
  // Slice the next 12 hours starting from the current hour (times are local via timezone=auto).
  const now = Date.now();
  const times = j.hourly.time;
  let start = times.findIndex((t) => new Date(t).getTime() >= now);
  if (start < 0) start = 0;
  const hourly: Hour[] = times.slice(start, start + 12).map((t, i) => ({
    time: t, tempC: j.hourly.temperature_2m[start + i]!, code: j.hourly.weather_code[start + i]!,
  }));
  return { tempC: j.current.temperature_2m, humidity: j.current.relative_humidity_2m, code: j.current.weather_code, unit: j.current_units.temperature_2m, hourly };
}

/** City search via Open-Meteo's keyless geocoding API. */
async function searchCity(q: string): Promise<City[]> {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=6&language=en&format=json`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const j = await res.json() as { results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string }[] };
  return (j.results ?? []).map((r) => ({
    name: r.name, lat: r.latitude, lon: r.longitude,
    label: [r.name, r.admin1, r.country].filter(Boolean).join(", "),
  }));
}

const fmtHour = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric" });

/** The dashboard weather chip; tap opens a panel with the hourly forecast + a city picker. */
export function WeatherCard() {
  const [loc, setLoc] = useState<GeoLoc>(loadLocation);
  const [w, setW] = useState<Weather | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setFailed(false); setW(null);
    fetchWeather(loc).then((res) => { if (live) setW(res); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [loc]);

  function pick(next: GeoLoc) { saveLocation(next); setLoc(next); }

  if (failed && !open) return null;
  const d = w ? describe(w.code) : null;
  return (
    <>
      <button className="weather-card" onClick={() => setOpen(true)} title="Weather & location">
        <span className="weather-glyph" aria-hidden>{d?.glyph ?? "…"}</span>
        <span className="weather-meta">
          <span className="weather-temp">{w ? `${Math.round(w.tempC)}${w.unit}` : "—"}</span>
          <span className="weather-sub">{d ? `${d.label} · ${loc.label}` : "Loading weather…"}</span>
        </span>
        {w && <span className="weather-hum">{w.humidity}%</span>}
      </button>
      {open && <WeatherPanel loc={loc} weather={w} onPick={pick} onClose={() => setOpen(false)} />}
    </>
  );
}

function WeatherPanel({ loc, weather, onPick, onClose }: { loc: GeoLoc; weather: Weather | null; onPick: (l: GeoLoc) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<City[]>([]);
  const [searching, setSearching] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 2) { setResults([]); return; }
    setSearching(true);
    timer.current = window.setTimeout(async () => {
      setResults(await searchCity(q.trim()));
      setSearching(false);
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  function useMyLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (p) => { onPick({ lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4), label: "My location" }); onClose(); },
      () => { /* denied — keep current */ },
      { timeout: 8000 },
    );
  }

  const d = weather ? describe(weather.code) : null;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet weather-sheet" onClick={(e) => e.stopPropagation()}>
        <span className="grab" />
        <div className="wx-now">
          <span className="wx-now-glyph" aria-hidden>{d?.glyph ?? "…"}</span>
          <div>
            <div className="wx-now-temp">{weather ? `${Math.round(weather.tempC)}${weather.unit}` : "—"}</div>
            <div className="wx-now-sub">{d ? `${d.label} · ${loc.label}` : "Loading…"}</div>
          </div>
        </div>

        {weather && weather.hourly.length > 0 && (
          <div className="wx-hourly">
            {weather.hourly.map((h) => {
              const hd = describe(h.code);
              return (
                <div key={h.time} className="wx-hour">
                  <span className="wx-hour-t">{fmtHour(h.time)}</span>
                  <span className="wx-hour-g" aria-hidden>{hd.glyph}</span>
                  <span className="wx-hour-deg">{Math.round(h.tempC)}°</span>
                </div>
              );
            })}
          </div>
        )}

        <div className="wx-picker">
          <input className="search" placeholder="Search a city…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <button onClick={useMyLocation}>Use my location</button>
        </div>
        {searching && <p className="muted">Searching…</p>}
        <div className="wx-results">
          {results.map((c) => (
            <button key={c.label} className="wx-result" onClick={() => { onPick({ lat: c.lat, lon: c.lon, label: c.name }); onClose(); }}>
              {c.label}
            </button>
          ))}
          {q.trim().length >= 2 && !searching && results.length === 0 && <p className="muted">No cities found.</p>}
        </div>
      </div>
    </div>
  );
}
