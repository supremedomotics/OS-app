/**
 * Homeowner-friendly errors (§ Errors) — one place that turns whatever the network or backend throws
 * into a calm, plain-language line: what happened and what to do, never a stack trace, HTTP code, or
 * protocol detail. Installer/Developer surfaces keep raw errors; this is only for homeowner chrome.
 */

/** Map an unknown thrown value to a short, human sentence. `fallback` is used when we can't do better
 * than a generic-but-kind message — and we NEVER surface a raw technical string to a homeowner. */
export function friendlyError(e: unknown, fallback = "Something went wrong. Please try again."): string {
  const raw = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const msg = raw.toLowerCase();

  // Can't reach the hub.
  if (/failed to fetch|networkerror|load failed|timeout|aborted|econnrefused|network request failed/.test(msg)) {
    return "Can't reach your home right now. Check it's powered on and connected, then try again.";
  }
  // Auth / permission.
  if (/\b401\b|unauthor|not authenticated|invalid token|session/.test(msg)) {
    return "Your session has expired. Please sign in again.";
  }
  if (/\b403\b|forbidden|not allowed|permission|denied/.test(msg)) {
    return "You don't have permission to do that. Ask your home's owner for access.";
  }
  if (/\b404\b|not found/.test(msg)) {
    return "That's no longer available — it may have been removed.";
  }
  if (/\b409\b|conflict|already exists|duplicate/.test(msg)) {
    return "That name is already in use. Try a different one.";
  }
  if (/\b5\d\d\b|internal|server error/.test(msg)) {
    return "Your home ran into a problem completing that. Please try again in a moment.";
  }
  // A short, clean validation sentence (no code/JSON/stack) is safe to show as-is.
  if (raw && raw.length < 80 && !/[{}<>]|https?:|error:|exception|\bat \b|\/v1\//i.test(raw)) {
    return raw;
  }
  return fallback;
}
