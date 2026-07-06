/**
 * Personalization (§ Personalization) — the app learns from real use, no configuration required.
 * Every time the homeowner activates a scene or acts on a device, we record it LOCALLY (this browser
 * only) so the dashboard can surface what they actually use: recently-used first, frequently-used
 * higher. This is genuine usage the client observes — never invented data, and it never leaves the
 * device or touches the backend.
 */
export type UseKind = "device" | "scene";
type Event = { kind: UseKind; id: string; ts: number };

const KEY = "supreme.usage";
const MAX = 200; // keep the log bounded; plenty for recency + frequency signals.

function read(): Event[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "[]") as Event[]; }
  catch { return []; }
}
function write(events: Event[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(events.slice(-MAX))); } catch { /* quota — ignore */ }
}

/** Record one interaction. Call at the moment the user acts (scene activate, device toggle/open). */
export function recordUse(kind: UseKind, id: string): void {
  const events = read();
  events.push({ kind, id, ts: Date.now() });
  write(events);
}

/** Most-recently-used distinct items (newest first), most recent occurrence per id. */
export function recentUses(limit = 6): { kind: UseKind; id: string }[] {
  const events = read();
  const seen = new Set<string>();
  const out: { kind: UseKind; id: string }[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]!;
    const k = `${e.kind}:${e.id}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ kind: e.kind, id: e.id });
  }
  return out;
}

/** Use-count per `${kind}:${id}` — a frequency signal for ordering (frequently-used first). */
export function useCounts(): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of read()) { const k = `${e.kind}:${e.id}`; m.set(k, (m.get(k) ?? 0) + 1); }
  return m;
}

/** Sort a list of {id} by descending use frequency, keeping the original order as the tiebreaker. */
export function byFrequency<T extends { id: string }>(items: T[], kind: UseKind): T[] {
  const counts = useCounts();
  return items
    .map((it, i) => ({ it, i, n: counts.get(`${kind}:${it.id}`) ?? 0 }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i))
    .map((x) => x.it);
}
