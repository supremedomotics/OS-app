import 'dart:async';

import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'data/discovery_factory.dart';
import 'data/secure_mobile_storage.dart';
import 'data/shared_prefs_paired_home_store.dart';
import 'features/home/home_screen.dart';
import 'features/spaces/spaces_screen.dart';
import 'features/spaces/room_screen.dart';
import 'features/experiences/experiences_screen.dart';
import 'features/now/now_screen.dart';
import 'features/settings/home_settings_screen.dart';
import 'features/settings/paired_home_controller.dart';
import 'features/settings/settings_screen.dart';
import 'runtime/runtime_controller.dart';

/// §Phase12.1 §25: the ConnectionManager operates against whichever Home is currently active
/// — no `MultiHubConnectionManager` exists. Watching `activeHomeIdProvider` means switching
/// Homes disposes the old manager (via `ref.onDispose`, Riverpod's normal provider-rebuild
/// lifecycle) and builds a fresh one scoped to the newly-selected Home.
final activeHomeIdProvider = StateProvider<String?>((ref) => null);

/// §Phase12.3 SECURE STORAGE — real Android Keystore / iOS Keychain backing via
/// `flutter_secure_storage` (`SecureSecretBytesStore`, `SecurePairedHomeAuthorizationStore`;
/// see their doc comments in `data/secure_mobile_storage.dart`). Neither private keys nor
/// bearer tokens are ever written to `SharedPreferences` — that store (`SharedPrefsPairedHomeStore`)
/// only ever holds non-sensitive Home metadata (hubId/projectId/displayName).
final pairedHomeAuthStoreProvider =
    Provider<PairedHomeAuthorizationStore>((ref) {
  final store = SecurePairedHomeAuthorizationStore();
  // Best-effort hydration from the platform secure store for every currently-paired Home, so
  // a restart doesn't force re-pairing when a still-valid (unexpired) session exists
  // (§Phase12.3 "RESTART persistence"). Fire-and-forget: providers below read synchronously
  // and simply see "no session yet" until this completes, which is the same honest state a
  // freshly-paired Home is in before its first `putSession`.
  unawaited(ref.read(pairedHomeControllerProvider).load().then((_) {
    return store.hydrate(
        ref.read(pairedHomeControllerProvider).homes.map((h) => h.hubId));
  }));
  return store;
});

/// This Mobile's own Ed25519 identity (§Phase12.2, Phase 11's `Ed25519MobileIdentity`) — ONE
/// instance for the app's lifetime, so pairing a second/third Home reuses the SAME Mobile
/// identity rather than generating a new one per Home (a Mobile is one cryptographic identity
/// authorized by many Hubs, never one identity per Hub). Backed by `SecureSecretBytesStore` —
/// real Keystore/Keychain storage (§Phase12.3), replacing Phase 11's in-memory stand-in.
final mobileIdentityStoreProvider =
    Provider<SecretBytesStore>((ref) => SecureSecretBytesStore());
final mobileIdentityProvider = Provider<Ed25519MobileIdentity>(
    (ref) => Ed25519MobileIdentity(ref.watch(mobileIdentityStoreProvider)));

/// §Phase12.3 mDNS — the production composition root's LAN discovery is now the REAL
/// `MdnsHubDiscovery` on platforms that support it (Android/iOS/desktop), with an honest,
/// documented web fallback (`discovery_factory_web.dart`) where no UDP multicast socket API
/// exists at all. `MockHubDiscovery` is untouched and still used directly by tests.
final platformDiscoveryProvider =
    Provider<HubDiscovery>((ref) => buildPlatformDiscovery());

/// §Phase12.8 — resolves a Home's real LAN base URL by scoping the platform's real discovery
/// (`platformDiscoveryProvider`) to exactly that `hubId` via `SingleHubDiscovery` (Phase 12.2)
/// — the same "which Hub is this" question `realPairHome`'s pairing flow already answers, now
/// answered for an ALREADY-paired Home too. Port choice matches `HttpPairingTransport`'s own
/// documented finding: the real REST/`/v1/stream` contract is served by the existing gateway
/// (Caddy :443), not the native/local `:7272` port, which has no HTTP listener for it.
Future<Uri?> resolveHomeBaseUrl(HubDiscovery discovery, String hubId) async {
  final hubs = await SingleHubDiscovery(discovery, hubId).discoverAllLan();
  if (hubs.isEmpty) return null;
  return Uri(scheme: 'https', host: hubs.first.address);
}

/// §Phase12.10 §4 — the ONE place a Home's `RemoteHubConfig` is built, reused by both
/// `connectionManagerProvider` (HTTP) and `runtimeControllerProvider` (event stream, via
/// `RemoteHubConfig.streamUri()`) so remote routing/auth logic is never duplicated between the
/// two (§4: "do not duplicate business logic between local and remote transports").
///
/// HONEST STATUS — PRODUCTION HARDENING REQUIRED: the broker base URL is still a placeholder.
/// No installer/account-provisioning flow in this repository yet tells a Mobile app which
/// Tunnel Broker instance its paired Hub dials out to (that's cloud account/fleet config, out
/// of `apps/new`'s scope) — this is the same gap `RemoteHubTransport`'s own class doc has
/// documented since Phase 10, unchanged by this phase. What Phase 12.10 DOES fix: the broker
/// URL is no longer duplicated inline at each call site, and Remote Access is never used unless
/// the homeowner's own per-Home switch (§3) is on.
RemoteHubConfig remoteHubConfigFor(
    String hubId, PairedHomeAuthorizationStore authStore) {
  return RemoteHubConfig(
    brokerUrl: Uri.parse('https://broker.supremeos.invalid'),
    hubId: hubId,
    bearerToken: () {
      final session = authStore.sessionFor(hubId);
      if (session == null) {
        throw StateError(
            'No authorization session for this Home — re-pair required.');
      }
      return session.bearerToken();
    },
  );
}

/// §Phase12.2 §11/§12: the ConnectionManager for the ACTIVE Home only — scoped via
/// `SingleHubDiscovery` (never the raw multi-Hub-wide discovery) and, for the remote path, a
/// `RemoteHubConfig.bearerToken` sourced from THIS Home's own session in
/// `pairedHomeAuthStoreProvider` — never another Home's. Watching `activeHomeIdProvider` means
/// switching Homes disposes the old manager (Riverpod's normal provider-rebuild lifecycle,
/// §Phase12.2 §15's stale-state protection at the connection layer) and builds a fresh one.
///
/// With no Home selected, `SingleHubDiscovery` is scoped to a hubId nothing will ever match —
/// the manager genuinely stays `offline`, never a fabricated "connected" (§16/§23).
///
/// §Phase12.8: the LAN transport is now the REAL `HttpHubTransport` — `makeLanTransport`
/// receives the real `Uri` `SingleHubDiscovery` just resolved (§Phase9's `DiscoveredHub`
/// address), and builds a client that speaks the real `/v1/home`/`/v1/devices`/
/// `/v1/devices/:id/command` contract directly against it, authenticated with this Home's own
/// Mobile-authorization session (never another Home's). `MockHubTransport` remains available
/// and is what tests use directly — it is no longer what the production composition root
/// builds. The remote path is unchanged: the real Phase 10 `RemoteHubTransport` against a real
/// `RemoteHubConfig`, gated on this Home actually having a session (no session →
/// `authenticate` throws → `reconnecting`, never a silent fake "connected").
/// `remoteAccessEnabled: false` preserves the OFF-by-default policy.
final connectionManagerProvider = Provider<ConnectionManager>((ref) {
  final hubId = ref.watch(activeHomeIdProvider);
  final authStore = ref.watch(pairedHomeAuthStoreProvider);
  // §Phase12.10 §3/§4 — the homeowner's own explicit per-Home choice, OFF by default. Watched
  // (not read-once) so flipping the Settings → Home switch actually takes effect immediately.
  final remoteAccessEnabled = ref.watch(activeHomeRemoteAccessEnabledProvider);
  final scopedHubId = hubId ?? '__no_home_selected__';

  final manager = ConnectionManager(
    discovery:
        SingleHubDiscovery(ref.watch(platformDiscoveryProvider), scopedHubId),
    makeLanTransport: (lanUri) => HttpHubTransport(
      baseUrl: Uri(scheme: 'https', host: lanUri.host),
      bearerToken: () {
        if (hubId == null) throw StateError('No Home selected.');
        final session = authStore.sessionFor(hubId);
        if (session == null) {
          throw StateError(
              'No authorization session for this Home — re-pair required.');
        }
        return session.bearerToken();
      },
    ),
    makeRemoteTransport: hubId == null
        ? null
        : () => RemoteHubTransport(
              config: remoteHubConfigFor(hubId, authStore),
            ),
    remoteAccessEnabled: remoteAccessEnabled,
  );
  ref.onDispose(manager.dispose);
  manager.start();
  return manager;
});

/// §Phase12.3 — the active Home's semantic repository. Rebuilds (and disposes the previous
/// one) every time `connectionManagerProvider` rebuilds, i.e. every Home switch — this is the
/// "dispose/release A-scoped state → activate B" requirement, expressed as an ordinary
/// Riverpod provider dependency rather than bespoke lifecycle code.
final homeStateRepositoryProvider = Provider<HomeStateRepository>((ref) {
  final repo = HubHomeStateRepository(ref.watch(connectionManagerProvider));
  ref.onDispose(repo.dispose);
  return repo;
});

/// §Phase12.3 NETWORK CHANGES — wires the real OS connectivity signal
/// (`connectivity_plus`) to the already-existing `ConnectionManager.notifyNetworkChanged()`
/// (Phase 11). `ConnectionManager` itself is unmodified; this only makes its existing method
/// reachable from the platform. Must be READ (not just declared) once at app start —
/// `RootShell` does that in `initState` — so the subscription is actually alive.
final networkChangeListenerProvider = Provider<void>((ref) {
  final sub = Connectivity().onConnectivityChanged.listen((_) {
    ref.read(connectionManagerProvider).notifyNetworkChanged();
  });
  ref.onDispose(sub.cancel);
});

/// §Phase12.10 §4 — mirrors the ACTIVE Home's `remoteAccessEnabled` flag into a watchable
/// Riverpod provider, the same bridging pattern `activeHomeIdProvider` already uses for
/// `PairedHomeController` (a plain `ChangeNotifier`, not itself a Riverpod state holder).
/// `connectionManagerProvider` watches this instead of reading `PairedHomeController` directly,
/// so toggling Remote Access in Settings → Home actually rebuilds the connection with the new
/// policy — never a stale, capture-at-construction-time value.
final activeHomeRemoteAccessEnabledProvider = StateProvider<bool>((ref) => false);

final pairedHomeControllerProvider = Provider<PairedHomeController>((ref) {
  final controller = PairedHomeController(SharedPrefsPairedHomeStore());
  void syncActiveHome() {
    // Keep the ConnectionManager's Home scope in sync with whichever Home the homeowner has
    // selected in Settings → Home (§25) — never inferred from display name (§10).
    final active = controller.activeHomeId;
    if (ref.read(activeHomeIdProvider) != active) {
      ref.read(activeHomeIdProvider.notifier).state = active;
    }
    final remoteEnabled = controller.activeHome?.remoteAccessEnabled ?? false;
    if (ref.read(activeHomeRemoteAccessEnabledProvider) != remoteEnabled) {
      ref.read(activeHomeRemoteAccessEnabledProvider.notifier).state =
          remoteEnabled;
    }
  }

  controller.addListener(syncActiveHome);
  controller.load();
  ref.onDispose(controller.dispose);
  return controller;
});

/// §Phase12.5 — the SupremeOS Mobile Runtime's Flutter-side owner. Read once at app start
/// (`RootShell.initState`, alongside `networkChangeListenerProvider`) so it outlives any single
/// screen — this is the object that stays alive across Home switches and app-minimization for
/// residential background responsibilities (§2), NOT tied to widget lifecycle.
/// §Phase12.10 §5 — is THIS specific (possibly background, non-active) Home's own Remote
/// Access switch on? Reads `PairedHomeController.homes` directly rather than the
/// active-Home-only `activeHomeRemoteAccessEnabledProvider`, since a background Home's stream
/// must honor ITS OWN setting, never the currently-selected Home's (§5: "no global singleton
/// may accidentally bind the stream to whichever Home is currently selected").
bool _remoteAccessEnabledFor(PairedHomeController homeController, String hubId) {
  for (final h in homeController.homes) {
    if (h.hubId == hubId) return h.remoteAccessEnabled;
  }
  return false;
}

/// §Phase12.10 §4/§6 — one-shot `ConnectionManager` for a (possibly background) Home's
/// authoritative snapshot, reusing the EXACT SAME local/remote selection primitive
/// `connectionManagerProvider` uses for the active Home (`SingleHubDiscovery` + `HttpHubTransport`
/// for LAN, `RemoteHubTransport`/`remoteHubConfigFor` for remote, gated on that Home's own
/// `remoteAccessEnabled`) — no second local/remote decision procedure.
Future<void> _refreshSnapshot({
  required HubDiscovery discovery,
  required PairedHomeAuthorizationStore authStore,
  required PairedHomeController homeController,
  required String hubId,
}) async {
  final session = authStore.sessionFor(hubId);
  if (session == null) return; // revoked/removed mid-flight — nothing to snapshot.
  final remoteEnabled = _remoteAccessEnabledFor(homeController, hubId);
  final manager = ConnectionManager(
    discovery: SingleHubDiscovery(discovery, hubId),
    makeLanTransport: (lanUri) => HttpHubTransport(
      baseUrl: Uri(scheme: 'https', host: lanUri.host),
      bearerToken: session.bearerToken,
    ),
    makeRemoteTransport: remoteEnabled
        ? () => RemoteHubTransport(config: remoteHubConfigFor(hubId, authStore))
        : null,
    remoteAccessEnabled: remoteEnabled,
  );
  await manager.start();
  final repo = HubHomeStateRepository(manager);
  // The fetch itself IS the reconciliation point (§10): every subsequent read from this
  // repository (or the active-Home one, once this Home is selected) now reflects this
  // authoritative snapshot rather than whatever was cached before reconnect.
  await repo.spaces();
  await repo.experiences();
  await manager.dispose();
}

final runtimeControllerProvider = Provider<RuntimeController>((ref) {
  final discovery = ref.watch(platformDiscoveryProvider);
  final homeController = ref.watch(pairedHomeControllerProvider);
  final authStore = ref.watch(pairedHomeAuthStoreProvider);
  final controller = RuntimeController(
    homeController: homeController,
    authStore: authStore,
    pushClient: PushRegistrationClient(),
    // §Phase12.8 — real: scopes the real platform discovery to exactly this hubId (§Phase12.2's
    // `SingleHubDiscovery`), same as `connectionManagerProvider`'s own resolution.
    resolveHomeBaseUrl: (hubId) => resolveHomeBaseUrl(discovery, hubId),
    // §Phase12.10 §4/§5 — LAN wss:// when reachable, else the real remote broker wss:// ONLY
    // when THIS Home's own Remote Access switch is on. This is the ONE place local-vs-remote
    // is decided for the event stream.
    resolveHomeStreamUri: (hubId) async {
      final lan = await resolveHomeBaseUrl(discovery, hubId);
      if (lan != null) return lan.replace(scheme: 'wss', path: '/v1/stream');
      if (!_remoteAccessEnabledFor(homeController, hubId)) return null;
      return remoteHubConfigFor(hubId, authStore).streamUri();
    },
    // PLATFORM STUB — no PlatformPushTokenSource wired yet; see its own doc comment for why
    // (no Firebase project configuration exists in this repository).
  );
  ref.onDispose(controller.dispose);

  // §Phase12.8/12.10 — real transport factory: the genuine `/v1/stream` WebSocket, dialed
  // either at the Home's real resolved LAN address or (§Phase12.9/12.10) the real Tunnel
  // Broker's stream route when Remote Access is on for that Home and LAN is unreachable.
  // `WebSocketHubEventStream` is used UNMODIFIED for both — one shared event-stream
  // abstraction, never a second implementation for "remote" (§4/§6).
  unawaited(controller.startEventStreamsForAllHomes(
    buildTransport: (hubId, streamUri, bearerToken) => WebSocketHubEventStream(
      streamUri: streamUri,
      bearerToken: bearerToken,
    ),
    onSnapshotRequired: (hubId) => _refreshSnapshot(
      discovery: discovery,
      authStore: authStore,
      homeController: homeController,
      hubId: hubId,
    ),
  ));

  return controller;
});

/// §Phase12.2 §4/§5 — the REAL pairing flow, replacing Phase 12.1's `UnimplementedError` stub:
/// discovers LAN Hubs → runs the actual Ed25519 challenge/response ceremony against the
/// chosen Hub's real `/v1/pairing/*` HTTP contract (`HttpPairingTransport`, `PairingClient`
/// from Phase 11/12, unmodified) → on success, stores the resulting `MobileAuthorization` in
/// this Home's OWN session slot (never another Home's) before a `PairedHome` is ever created.
/// A failed pairing throws, and `HomeSettingsScreen` (unchanged since Phase 12.1) never calls
/// `PairedHomeManager.addHome` on a thrown result — so a failed pairing genuinely leaves no
/// local Home record (§5: "if pairing fails, no paired Home is created").
///
/// HONEST STATUS: `discovery` is still `MockHubDiscovery` — no real mDNS wiring exists in any
/// Flutter composition root yet (Phase 9 carry-forward, PRODUCTION HARDENING REQUIRED). This
/// function's own logic (discover → pick → sign → verify → store session) is REAL and covered
/// by `HttpPairingTransport`/`PairingClient`'s real-HTTP-shape tests; only the "which Hub is
/// physically on this network" step is a stand-in. Initial pairing is deliberately LAN-only —
/// see `HttpPairingTransport`'s own class doc for why remote-only initial pairing would be a
/// broker chicken-and-egg problem, not a missing feature (§8).
Future<PairHomeResult> realPairHome({
  required HubDiscovery discovery,
  required Ed25519MobileIdentity identity,
  required PairedHomeAuthorizationStore authStore,
  required String pairingCode,
  http.Client? httpClient,
}) async {
  final hubs = await discovery.discoverAllLan();
  if (hubs.isEmpty) {
    throw StateError(
        'No SupremeOS Hub was found on this network. Make sure your phone and Hub are on the same Wi-Fi.');
  }
  // PENDING: when more than one Hub answers, a real picker UI should let the homeowner choose
  // (§7: "user confirms intended Home") — this composition root pairs with the first result.
  final chosen = hubs.first;
  final transport = HttpPairingTransport(
      baseUrl: Uri(scheme: 'https', host: chosen.address), client: httpClient);
  final pairingClient = PairingClient(identity: identity, transport: transport);

  final authorization = await pairingClient.pairUsingCode(pairingCode);

  authStore.putSession(
      authorization.hubId, AuthorizedMobileSession(authorization));

  return PairHomeResult(
    hubId: authorization.hubId,
    projectId: authorization.projectId,
    suggestedDisplayName: chosen.identity.displayName,
  );
}

void main() {
  runApp(const ProviderScope(child: SupremeMobileApp()));
}

class SupremeMobileApp extends StatelessWidget {
  const SupremeMobileApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'SupremeOS',
      debugShowCheckedModeBanner: false,
      theme: buildSupremeTheme(),
      home: const AdaptiveScope(child: RootShell()),
    );
  }
}

/// The residence-first primary navigation (§5): Home / Spaces / Experiences /
/// Now / More. Never device-centric — nothing here lists devices directly.
class RootShell extends ConsumerStatefulWidget {
  const RootShell({super.key});
  @override
  ConsumerState<RootShell> createState() => _RootShellState();
}

class _RootShellState extends ConsumerState<RootShell> {
  int _index = 0;
  Space? _openSpace;

  @override
  void initState() {
    super.initState();
    // §Phase12.3 NETWORK CHANGES — this is the one place the OS connectivity listener needs to
    // actually be read to stay alive for the app's lifetime; `networkChangeListenerProvider`
    // itself does the real work (forwarding to `ConnectionManager.notifyNetworkChanged()`).
    ref.read(networkChangeListenerProvider);
    // §Phase12.5 — same lifecycle reasoning: the Mobile Runtime must outlive any single
    // screen, so it is read here once, not lazily on first use from some deeper widget.
    ref.read(runtimeControllerProvider);
  }

  static const _destinations = [
    NavigationDestination(
        icon: Icon(Icons.home_outlined),
        selectedIcon: Icon(Icons.home),
        label: 'Home'),
    NavigationDestination(
        icon: Icon(Icons.door_front_door_outlined),
        selectedIcon: Icon(Icons.door_front_door),
        label: 'Spaces'),
    NavigationDestination(
        icon: Icon(Icons.auto_awesome_outlined),
        selectedIcon: Icon(Icons.auto_awesome),
        label: 'Experiences'),
    NavigationDestination(
        icon: Icon(Icons.dashboard_outlined),
        selectedIcon: Icon(Icons.dashboard),
        label: 'Now'),
    NavigationDestination(
        icon: Icon(Icons.more_horiz),
        selectedIcon: Icon(Icons.more_horiz),
        label: 'More'),
  ];

  @override
  Widget build(BuildContext context) {
    if (_openSpace != null) {
      return RoomScreen(
          space: _openSpace!, onBack: () => setState(() => _openSpace = null));
    }

    final screens = [
      const HomeScreen(),
      SpacesScreen(onOpenSpace: (s) => setState(() => _openSpace = s)),
      const ExperiencesScreen(),
      const NowScreen(),
      const _MoreScreen(),
    ];

    return Scaffold(
      body: SafeArea(child: screens[_index]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: _destinations,
      ),
    );
  }
}

class _MoreScreen extends ConsumerWidget {
  const _MoreScreen();
  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return ListView(
      padding: const EdgeInsets.all(24),
      children: [
        Text('More', style: text.title),
        const SizedBox(height: 24),
        ListTile(title: Text('Devices', style: text.body)),
        ListTile(title: Text('Automations', style: text.body)),
        ListTile(
          title: Text('Settings', style: text.body),
          onTap: () => Navigator.of(context).push(MaterialPageRoute(
            builder: (_) => SettingsScreen(
              homeController: ref.read(pairedHomeControllerProvider),
              onPairHome: (code) => realPairHome(
                discovery: ref.read(platformDiscoveryProvider),
                identity: ref.read(mobileIdentityProvider),
                authStore: ref.read(pairedHomeAuthStoreProvider),
                pairingCode: code,
              ),
              activeConnectionManager: ref.read(connectionManagerProvider),
            ),
          )),
        ),
        ListTile(title: Text('Professional Mode', style: text.body)),
      ],
    );
  }
}
