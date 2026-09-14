import 'hub_defaults.dart';

/// A transport is how bytes actually get to the Hub. The UI layer never sees
/// this type — only [ConnectionManager]'s semantic state (§14).
abstract class HubTransport {
  /// True once this transport has a live, authenticated session with the Hub.
  bool get isConnected;

  /// Opens the underlying connection ONLY — discovery told the client
  /// *where* the Hub is, this is *how* to reach it. Deliberately separate
  /// from [authenticate] (§ authentication boundary): a socket/TLS
  /// handshake succeeding is not the same claim as "this session is
  /// authorized," and [ConnectionManager] surfaces them as distinct states
  /// so a client can never treat "connected transport" as "authenticated."
  Future<void> connect();

  /// Establishes the authenticated session on an already-open connection.
  /// Must throw if the Hub rejects the client's credentials/device
  /// identity — [ConnectionManager] maps that to
  /// `ConnectionStatus.authenticationFailed`, never a silent fallback to
  /// "connected."
  Future<void> authenticate();

  Future<void> disconnect();

  /// Fire-and-forget or request/response command dispatch. The semantic layer
  /// above decides what "success" means (requested vs confirmed, §31) —
  /// a transport only reports whether the bytes made it. Discovery and
  /// control are separate concerns (§ control connection) — this is the
  /// authenticated control channel, never the discovery protocol itself.
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body);

  /// §Phase12.8 — a real authenticated READ, distinct from [sendCommand]. Added because the
  /// actual Hub REST contract (`services/gateway/src/routes/{home,devices,scenes}.ts`,
  /// discovered in Phase 12.4) uses `GET` for reads and `POST` for commands/activation — a
  /// generic `sendCommand` (always POST, per `RemoteHubTransport`'s original design) cannot
  /// reach a `GET` route. This is the "smallest required extension" Phase 12.4/12.7 already
  /// flagged as pending, not a redesign: every existing implementation gains one new method,
  /// nothing else about the interface changes.
  Future<Map<String, dynamic>> get(String path);

  /// Live state/event stream from the Hub (WSS locally, tunnel remotely).
  Stream<Map<String, dynamic>> events();
}

/// A Hub's persistent identity (§ Hub identity) — deliberately NOT just an
/// IP/hostname/port. `hubId` is expected to be a stable identifier the Hub
/// itself generates and keeps across restarts/address changes (the
/// project's existing direction for this is a real cryptographic identity —
/// see the Hub-side enrollment work this repo already has underway — this
/// type is the client-side projection of that, not a competing scheme).
class HubIdentity {
  final String hubId;
  final String displayName;
  final String? projectId;

  const HubIdentity(
      {required this.hubId, required this.displayName, this.projectId});

  @override
  bool operator ==(Object other) =>
      other is HubIdentity &&
      other.hubId == hubId &&
      other.projectId == projectId;

  @override
  int get hashCode => Object.hash(hubId, projectId);
}

/// One discoverable Hub on the LAN right now (§ multiple Hubs) — the
/// network-address half of the picture, paired with the address-independent
/// [identity]. A discovery pass can return several of these; the caller (or
/// a future selection step keyed on `identity.projectId`/auth) decides which
/// one to actually connect to. `port` defaults to
/// [SupremeOSHubDefaults.defaultPort] but is carried per-result rather than
/// assumed, since a future professional setup may run a Hub on a configured
/// non-default port (§ port configuration) without that becoming a constant
/// anyone has to change.
class DiscoveredHub {
  final HubIdentity identity;
  final String address;
  final int port;
  final String? protocolVersion;
  final bool available;

  const DiscoveredHub({
    required this.identity,
    required this.address,
    this.port = SupremeOSHubDefaults.defaultPort,
    this.protocolVersion,
    this.available = true,
  });

  Uri get controlUri => Uri.parse('https://$address:$port');
}

/// Discovers SupremeOS Hub(s) on the local network (§ discovery mechanism).
/// This is a LAN service-discovery abstraction, not a specific transport —
/// a real implementation backs it with mDNS/DNS-SD browsing for
/// [SupremeOSHubDefaults.mdnsServiceType] (or another platform-appropriate
/// local discovery mechanism), never by sweeping every IP on the subnet.
/// Kept as an interface so the connection/UI layers can be built and tested
/// before that platform wiring lands (§43) — see the class doc on
/// [SupremeOSHubDefaults] for exactly what exists today vs. what's still a
/// documented seam.
///
/// Discovery belongs here and ONLY here (§ discovery should not be UI
/// logic) — [ConnectionManager] is the sole caller; no screen/widget may
/// call these methods directly.
abstract class HubDiscovery {
  /// Returns the LAN hub address, or null if none was found within
  /// [timeout]. Kept for the common single-Hub case
  /// ([ConnectionManager]'s normal path); equivalent to taking the first
  /// available result of [discoverAllLan].
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)});

  /// The full LAN discovery picture (§ multiple Hubs) — every Hub visible
  /// right now, not just the one this client will connect to. A homeowner
  /// UI should never render this raw list; it exists for Hub
  /// selection/identity-matching logic, not as user-facing content.
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)});
}

/// Thrown by [HubTransport.authenticate] when the Hub rejects the client's
/// credentials/device identity — distinct from a generic connection error
/// so [ConnectionManager] can route it to `authenticationFailed` rather
/// than an endless reconnect loop against a Hub that will never accept
/// this client (§ authentication boundary).
class AuthenticationException implements Exception {
  final String message;
  const AuthenticationException(this.message);
  @override
  String toString() => 'AuthenticationException: $message';
}
