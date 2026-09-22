/**
 * Companion endpoint discovery (§ Apple TV Phase 3.1). Verified against pyatv's real
 * source this phase: `pyatv/protocols/companion/__init__.py`'s `scan()` registers the
 * Companion protocol against the literal service type `"_companion-link._tcp.local"`
 * (`companion_service_handler` builds a `MutableService` straight from `mdns_service.
 * port` — no separate port-discovery step, no TXT-record port override). This mirrors
 * exactly how `apple-tv-driver.ts` already discovers MRP's `_mediaremotetv._tcp.local`
 * — reuses the SAME generic `mdnsBrowse()` helper, not a second discovery mechanism.
 *
 * Scoped per lookup (one call = one bounded browse), never a global/singleton
 * discovery service — a caller (the MRP client, per-binding) invokes this fresh each
 * time it needs a Companion address, and `mdnsBrowse()` itself already closes its
 * socket and clears its timeout on completion (see mdns.ts), so there is nothing here
 * to leak or clean up between calls.
 */
import { mdnsBrowse, type MdnsService } from "./mdns.js";

const COMPANION_SERVICE = "_companion-link._tcp.local";

/**
 * Finds the Companion endpoint for the SAME physical Apple TV already reachable at
 * `mrpHost` (its MRP address) — correlated by IP address, since both services are
 * advertised by the same device but as independent mDNS instances (verified: nothing
 * ties an MRP instance name to a Companion instance name; address is the only reliable
 * correlation this phase established evidence for). Returns `null` — never throws, never
 * fabricates a port — when no matching Companion service is found within the bounded
 * mDNS timeout (Apple TV offline, Companion disabled, or a discovery-hostile network).
 */
export async function discoverCompanionAddress(
  mrpHost: string,
  browse: (serviceType: string) => Promise<MdnsService[]> = mdnsBrowse,
): Promise<string | null> {
  let services: MdnsService[];
  try {
    services = await browse(COMPANION_SERVICE);
  } catch {
    return null; // discovery-hostile network — honest "not found", never a crash
  }
  const match = services.find((s) => s.host === mrpHost || s.addresses.includes(mrpHost));
  return match ? `${mrpHost}:${match.port}` : null;
}
