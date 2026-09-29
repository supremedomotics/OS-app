/**
 * The hub bakes SUPREME_STREAM_BASE_URL (built from the install-time domain, "localhost" on a
 * LAN-only install) into the stream URLs the gateway returns. A browser on another machine
 * resolves that "localhost" to itself and the connection is refused. This app is always served by
 * the same Caddy that proxies /stream/*, so a /stream/ URL is only ever correct relative to the
 * origin the page was loaded from — rebase it onto that origin.
 */
export function toSameOriginStreamUrl(url: string, pageOrigin: string = window.location.origin): string {
  try {
    const u = new URL(url);
    if (!u.pathname.startsWith("/stream/") || u.origin === pageOrigin) return url;
    return `${pageOrigin}${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
