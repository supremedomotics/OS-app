/// The ONE authoritative place SupremeOS's default Hub control port lives.
/// Mobile, Touch Panel, future Web/Watch clients, and future SupremeOS tools
/// all import this instead of hardcoding a port — never duplicate `7272`
/// anywhere else in this codebase.
///
/// COMPATIBILITY NOTE (read before wiring this to a real Hub): the actual
/// running SupremeOS Hub (`services/gateway`) currently listens on
/// `SUPREME_PORT` (default **8080**, see `services/gateway/src/config.ts`),
/// reverse-proxied to LAN clients over HTTPS on **443** by Caddy
/// (`infra/hub-compose/Caddyfile`, `docker-compose.yml`). Nothing in the
/// existing repository uses 7272 today, and no mDNS/DNS-SD/UDP discovery
/// mechanism exists yet — the only discovery tool today
/// (`tools/discover-supremeos-url`) probes fixed candidate URLs rather than
/// advertising a service.
///
/// `7272` is adopted here as the forward-looking SupremeOS platform
/// convention for the new direct client↔Hub control channel `apps/new`
/// establishes (§ platform convention) — distinct from the existing
/// browser-facing HTTPS/Caddy path used by `web-installer`/`web-homeowner`.
/// Whether the real Hub eventually also listens on 7272 directly (or Caddy
/// gains a stream/passthrough proxy to it) is a Hub-side infrastructure
/// decision outside `apps/new`'s scope — this constant does not silently
/// change `services/gateway`/`infra/hub-compose`, and doesn't assume that
/// decision has been made.
class SupremeOSHubDefaults {
  const SupremeOSHubDefaults._();

  /// Default TCP port for direct SupremeOS Hub client control connections.
  static const int defaultPort = 7272;

  /// Documented service-discovery identifier a real mDNS/DNS-SD
  /// implementation should advertise/browse for (§ discovery mechanism) —
  /// analogous to `_http._tcp` but SupremeOS-specific, so a client never
  /// confuses a generic web server for a Hub. Not implemented yet (no
  /// mDNS package is wired in `apps/new` — see [HubDiscovery] in
  /// `transport.dart`, the seam a real implementation plugs into); this is
  /// the name that implementation must use once it exists.
  static const String mdnsServiceType = '_supremeos._tcp';
}
