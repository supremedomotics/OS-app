/**
 * Multi-home registry for the web app (blueprint §16) — parity with the Flutter home switcher.
 * One account can reach several homes (Mumbai Villa, Dubai Apartment, …); each home is one hub at a
 * base URL. The list + the active selection persist in localStorage so a switch survives reloads,
 * and each home keeps its OWN session (see {@link homeTokenStore}) so switching doesn't force a
 * re-login. A home is added from Settings → Homes (name + hub address).
 */
import type { TokenStore } from "@supreme/sdk";

export interface Home {
  id: string;
  name: string;
  /** The hub base URL (LAN-direct in the home, or a cloud/relay route when remote). */
  baseUrl: string;
}

const HOMES_KEY = "supreme.homes";
const ACTIVE_KEY = "supreme.activeHome";
const ENV_URL = (import.meta.env.VITE_SUPREME_API_URL as string | undefined) ?? "http://127.0.0.1:8080";

function normalizeUrl(url: string): string {
  const t = url.trim().replace(/\/$/, "");
  if (!t) return t;
  return /^https?:\/\//i.test(t) ? t : `http://${t}`;
}

function read<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Every registered home. Seeds a default "This home" (from the build-time URL) on first run. */
export function loadHomes(): Home[] {
  const homes = read<Home[]>(HOMES_KEY);
  if (homes && homes.length > 0) return homes;
  const seed: Home = { id: "default", name: "This home", baseUrl: normalizeUrl(ENV_URL) };
  saveHomes([seed]);
  return [seed];
}

export function saveHomes(homes: Home[]): void {
  try {
    localStorage.setItem(HOMES_KEY, JSON.stringify(homes));
  } catch {
    /* private-mode / storage disabled — the in-memory default still works this session. */
  }
}

export function activeHomeId(): string {
  const id = read<string>(ACTIVE_KEY);
  const homes = loadHomes();
  if (id && homes.some((h) => h.id === id)) return id;
  return homes[0]!.id;
}

export function activeHome(): Home {
  const homes = loadHomes();
  return homes.find((h) => h.id === activeHomeId()) ?? homes[0]!;
}

export function setActiveHome(id: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, JSON.stringify(id));
  } catch {
    /* ignore */
  }
}

/** Add (or update by URL) a home. Returns the new list. A stable id is derived from the URL. */
export function addHome(name: string, baseUrl: string): Home[] {
  const url = normalizeUrl(baseUrl);
  const id = `h_${Math.abs(hash(url))}`;
  const homes = loadHomes().filter((h) => h.baseUrl !== url);
  const home: Home = { id, name: name.trim() || url.replace(/^https?:\/\//, ""), baseUrl: url };
  const next = [...homes, home];
  saveHomes(next);
  return next;
}

export function removeHome(id: string): Home[] {
  const next = loadHomes().filter((h) => h.id !== id);
  const safe = next.length > 0 ? next : loadHomes();
  saveHomes(safe);
  if (activeHomeId() === id && safe[0]) setActiveHome(safe[0].id);
  return safe;
}

/** A quick reachability probe used by the Add-home form (unauthenticated setup status). */
export async function testHome(baseUrl: string): Promise<{ ok: boolean; systemName?: string }> {
  try {
    const res = await fetch(`${normalizeUrl(baseUrl)}/v1/setup/status`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false };
    const j = (await res.json()) as { systemName?: string };
    return { ok: true, systemName: j.systemName };
  } catch {
    return { ok: false };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * A localStorage-backed {@link TokenStore} scoped to the ACTIVE home, so each hub keeps its own
 * session across reloads (switching a home is a reload) and signing out of one home doesn't touch
 * another. Falls back to in-memory if storage is unavailable.
 */
export function homeTokenStore(): TokenStore {
  const key = `supreme.tokens.${activeHomeId()}`;
  let mem: { accessToken: string; refreshToken: string } | null = null;
  return {
    get() {
      if (mem) return mem;
      return read<{ accessToken: string; refreshToken: string }>(key);
    },
    set(tokens) {
      mem = tokens;
      try {
        if (tokens) localStorage.setItem(key, JSON.stringify(tokens));
        else localStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
  };
}
