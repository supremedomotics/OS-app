import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

/// Multi-home client architecture (blueprint §16): after a single Supreme login the app lists
/// every home the account can access and switches between them INSTANTLY (no logout). Each home
/// is reached over the fastest correct path — verified LAN-direct (mDNS) when on the home's
/// network, else the cloud Tunnel Broker — and the transition is transparent to the UI because
/// the active base URL is just a provider every screen already reads.

/// How the app is currently reaching a home's hub.
enum ConnectionMode { local, cloud, offline }

/// A home the signed-in account can access. One hub per home (blueprint §6).
@immutable
class HomeRef {
  const HomeRef({
    required this.hubId,
    required this.name,
    required this.role,
    required this.cloudRouteUrl,
    this.localBaseUrl,
    this.fingerprint,
  });

  /// The hub's globally-unique id (UUIDv7).
  final String hubId;
  final String name;

  /// This account's role in the home (owner/admin/homeowner/family/guest/…).
  final String role;

  /// Cloud route through the Tunnel Broker — always reachable off-LAN.
  final String cloudRouteUrl;

  /// Verified LAN base URL discovered via mDNS, when the hub is on this network.
  final String? localBaseUrl;

  /// Device public-key fingerprint, pinned to verify a discovered LAN hub is really ours.
  final String? fingerprint;

  bool get isLocalReachable => localBaseUrl != null && localBaseUrl!.isNotEmpty;

  HomeRef withLocal(String? localBaseUrl) => HomeRef(
        hubId: hubId,
        name: name,
        role: role,
        cloudRouteUrl: cloudRouteUrl,
        localBaseUrl: localBaseUrl,
        fingerprint: fingerprint,
      );

  factory HomeRef.fromJson(Map<String, dynamic> json) => HomeRef(
        hubId: json['hubId'] as String,
        name: json['name'] as String,
        role: (json['role'] as String?) ?? 'homeowner',
        cloudRouteUrl: json['cloudRouteUrl'] as String,
        localBaseUrl: json['localBaseUrl'] as String?,
        fingerprint: json['fingerprint'] as String?,
      );
}

/// The resolved connection for the active home: which base URL + mode is live right now.
@immutable
class HomeConnection {
  const HomeConnection({required this.home, required this.baseUrl, required this.mode});
  final HomeRef home;
  final String baseUrl;
  final ConnectionMode mode;

  /// WSS/HTTP scheme mirror of the base URL.
  String get wsUrl => baseUrl.replaceFirst(RegExp(r'^http'), 'ws');
}

/// The signed-in cloud account session (identity plane). Survives home switches.
@immutable
class CloudSession {
  const CloudSession({
    required this.accountId,
    required this.email,
    required this.accessToken,
    required this.refreshToken,
  });
  final String accountId;
  final String email;
  final String accessToken;
  final String refreshToken;
}

/// LAN discovery seam — a platform mDNS/DNS-SD plugin implements this; the default finds nothing
/// (so the app uses the cloud route). Keeping it a seam lets the resolver stay pure + testable.
abstract class LocalDiscovery {
  /// Returns hubId → verified local base URL for hubs found (and fingerprint-matched) on the LAN.
  Future<Map<String, String>> discover(List<HomeRef> homes);
}

class NoLocalDiscovery implements LocalDiscovery {
  const NoLocalDiscovery();
  @override
  Future<Map<String, String>> discover(List<HomeRef> homes) async => const {};
}

/// Minimal cloud identity-plane client (login + list homes). The edge aggregates the hub
/// registry + membership graph into the `homes` shape the app consumes.
class CloudClient {
  CloudClient({required this.cloudBaseUrl, http.Client? httpClient})
      : _http = httpClient ?? http.Client();

  final String cloudBaseUrl;
  final http.Client _http;

  Future<CloudSession?> login(String email, String password) async {
    final res = await _http.post(
      Uri.parse('$cloudBaseUrl/v1/auth/login'),
      headers: const {'content-type': 'application/json'},
      body: jsonEncode({
        'kind': 'email',
        'value': email,
        'password': password,
        'device': {'name': 'Supreme app', 'platform': 'ios'},
      }),
    );
    if (res.statusCode >= 400) return null;
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    return CloudSession(
      accountId: (body['device'] as Map<String, dynamic>?)?['accountId'] as String? ?? '',
      email: email,
      accessToken: body['accessToken'] as String,
      refreshToken: body['refreshToken'] as String,
    );
  }

  Future<List<HomeRef>> homes(CloudSession session) async {
    final res = await _http.get(
      Uri.parse('$cloudBaseUrl/v1/homes'),
      headers: {'authorization': 'Bearer ${session.accessToken}'},
    );
    if (res.statusCode >= 400) return const [];
    final body = jsonDecode(res.body) as Map<String, dynamic>;
    final list = (body['homes'] as List<dynamic>? ?? const [])
        .map((e) => HomeRef.fromJson(e as Map<String, dynamic>))
        .toList();
    return list;
  }
}

// ── Riverpod wiring ─────────────────────────────────────────────────────────────────────────

/// The cloud account session — null until login. Survives home switches and transports.
final cloudSessionProvider = StateProvider<CloudSession?>((ref) => null);

/// All homes the account can access (Mumbai Villa, Dubai Apartment, Farmhouse, …).
final homesProvider = StateProvider<List<HomeRef>>((ref) => const []);

/// The currently-selected home id; null = use the first available.
final activeHomeIdProvider = StateProvider<String?>((ref) => null);

/// The active [HomeRef] (selected, or the first available).
final activeHomeProvider = Provider<HomeRef?>((ref) {
  final homes = ref.watch(homesProvider);
  if (homes.isEmpty) return null;
  final id = ref.watch(activeHomeIdProvider);
  for (final h in homes) {
    if (h.hubId == id) return h;
  }
  return homes.first;
});

/// The resolved connection for the active home — prefer verified LAN, else the cloud route.
/// This is the single seam the rest of the app reads, so switching homes or transports is
/// transparent (every screen just rebuilds against the new base URL).
final homeConnectionProvider = Provider<HomeConnection?>((ref) {
  final home = ref.watch(activeHomeProvider);
  if (home == null) return null;
  if (home.isLocalReachable) {
    return HomeConnection(home: home, baseUrl: home.localBaseUrl!, mode: ConnectionMode.local);
  }
  return HomeConnection(home: home, baseUrl: home.cloudRouteUrl, mode: ConnectionMode.cloud);
});

/// Cloud identity-plane base URL (the Supreme API edge). Empty = local-only single-hub dev, in
/// which case the multi-home layer stays dormant and the app uses the local gateway. Set via
/// `--dart-define=SUPREME_CLOUD_URL=…` for cloud-anchored login + multi-home.
final cloudBaseUrlProvider =
    Provider<String>((ref) => const String.fromEnvironment('SUPREME_CLOUD_URL'));

/// After a successful sign-in, populate the cloud session + the account's homes (so the home
/// switcher and per-home connection routing go live). NON-FATAL and a no-op when no cloud URL is
/// configured — the app then runs the existing local single-hub flow (invariant: local-first).
Future<void> hydrateMultiHome(WidgetRef ref, String email, String password) async {
  final cloudUrl = ref.read(cloudBaseUrlProvider);
  if (cloudUrl.isEmpty) return;
  try {
    final client = CloudClient(cloudBaseUrl: cloudUrl);
    final session = await client.login(email, password);
    if (session == null) return;
    final homes = await client.homes(session);
    ref.read(cloudSessionProvider.notifier).state = session;
    ref.read(homesProvider.notifier).state = homes;
    if (homes.isNotEmpty) {
      ref.read(activeHomeIdProvider.notifier).state = homes.first.hubId;
    }
  } catch (_) {
    // Cloud unreachable / not provisioned — keep the local single-hub session.
  }
}
