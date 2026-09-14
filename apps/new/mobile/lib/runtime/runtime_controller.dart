import 'dart:async';

import 'package:supreme_os_core/supreme_os_core.dart';

import '../features/settings/paired_home_controller.dart';

/// Supplies this device's real platform push token (FCM on Android, APNs on iOS) and notifies
/// on rotation. §Phase12.5 §18: kept behind an interface so `apps/new/shared`/this file's own
/// logic stay platform-neutral; a real Flutter app implements this with `firebase_messaging`
/// (or an APNs-only path on iOS) at the composition root.
///
/// HONEST STATUS — PLATFORM STUB / DEVICE CONFIG REQUIRED: no implementation is wired into
/// `main.dart` this phase. Doing so needs a real Firebase project (`google-services.json` /
/// `GoogleService-Info.plist`) this repository does not have; adding the `firebase_messaging`
/// dependency without that configuration would build but silently fail on a real device,
/// which is exactly the kind of "looks-implemented" gap this project's conventions forbid.
abstract class PlatformPushTokenSource {
  Future<String?> currentToken();
  Stream<String> get onTokenRefresh;
  String get platform; // "fcm" | "apns"
}

/// The Mobile-side half of the SupremeOS Mobile Runtime (§Phase12.5 §2) — owns a
/// [MobileRuntime] instance for the app's lifetime, keeps its authorized-Home set in sync with
/// [PairedHomeController], and drives real push-token registration per Home via
/// [PushRegistrationClient] against the real `/v1/push/tokens` contract.
///
/// Deliberately NOT tied to Flutter widget lifecycle (§2: "closing a screen must not terminate
/// residential background responsibilities") — this object outlives any single screen; only
/// process death ends it, and [MobileRuntime] itself holds no platform resource that needs
/// disposal beyond its own streams.
class RuntimeController {
  final MobileRuntime runtime;
  final PairedHomeController homeController;
  final PairedHomeAuthorizationStore authStore;
  final PushRegistrationClient pushClient;
  final PlatformPushTokenSource? pushTokenSource;

  /// Resolves the URL push registration should target for a given Home — the same
  /// "which Hub is this" question `realPairHome`'s discovery step answers for pairing. PENDING
  /// the same way: no production resolver is wired yet (LAN discovery + remote broker routing
  /// per Home is Phase 12.4's own documented next step), so [registerPushTokenForAllHomes]
  /// simply skips a Home this returns null for rather than guessing an address.
  final Future<Uri?> Function(String hubId) resolveHomeBaseUrl;

  /// §Phase12.10 §4/§5 — resolves the URI the event stream should connect to for this Home:
  /// the real LAN `wss://.../v1/stream` when reachable, else the real
  /// `wss://<broker>/v1/route/<hubId>/stream` (§Phase12.9) IF AND ONLY IF this Home's own
  /// `remoteAccessEnabled` (§3) is on, else null. This is the ONE decision point where
  /// local-vs-remote is chosen for the live stream — `buildTransport` below never re-decides
  /// it, so local/remote selection logic exists in exactly one place, per Home.
  final Future<Uri?> Function(String hubId) resolveHomeStreamUri;

  final Map<String, HomeEventStreamSession> _streamSessions = {};

  RuntimeController({
    required this.homeController,
    required this.authStore,
    required this.pushClient,
    required this.resolveHomeBaseUrl,
    required this.resolveHomeStreamUri,
    this.pushTokenSource,
    MobileRuntime? runtime,
  }) : runtime = runtime ?? MobileRuntime() {
    homeController.addListener(_syncAuthorizedHomes);
    _syncAuthorizedHomes();
  }

  void _syncAuthorizedHomes() {
    runtime.updateAuthorizedHomes(homeController.homes.map((h) => h.hubId));
    // §Phase12.7 §5/§22: a Home removed/revoked from `homeController` must have its event
    // stream disposed too — never left running against a Home that's no longer paired.
    final currentHubIds = homeController.homes.map((h) => h.hubId).toSet();
    final stale = _streamSessions.keys
        .where((id) => !currentHubIds.contains(id))
        .toList();
    for (final id in stale) {
      _streamSessions.remove(id)?.dispose();
    }
  }

  /// §Phase12.7 — starts the real `/v1/stream` event session for every currently-authorized
  /// Home that has a live one ([authStore]) and a resolvable address ([resolveHomeBaseUrl]) —
  /// same skip-don't-fabricate policy as [registerPushTokenForAllHomes]. Idempotent per Home
  /// (§21/§22: "runtime starts again → no duplicate stream") — a Home whose session is already
  /// running is left alone.
  ///
  /// [onSnapshotRequired] is supplied by the composition root — it should re-fetch that Home's
  /// authoritative semantic state (`HomeStateRepository`) and reconcile it (§10). PENDING in
  /// the current composition root: there is no per-Home `HomeStateRepository` yet (Phase 12.3's
  /// repository is built only for the ACTIVE Home) — main.dart wires a documented no-op here
  /// until that exists, which is honest, not silently broken: `HomeEventStreamSession` still
  /// buffers/forwards live events correctly even when the snapshot callback does nothing.
  Future<void> startEventStreamsForAllHomes({
    required EventStreamTransport Function(
            String hubId, Uri streamUri, String Function() bearerToken)
        buildTransport,
    required Future<void> Function(String hubId) onSnapshotRequired,
  }) async {
    for (final home in homeController.homes) {
      if (_streamSessions.containsKey(home.hubId)) continue; // already running
      final session = authStore.sessionFor(home.hubId);
      if (session == null) {
        continue; // no live session — skip, don't fabricate one.
      }
      // §Phase12.10 §4/§5 — LAN when reachable, else the real remote broker stream ONLY if
      // THIS Home's own Remote Access switch is on (never a silent fallback, §3/§12).
      final streamUri = await resolveHomeStreamUri(home.hubId);
      if (streamUri == null) continue; // can't reach this Home yet — skip.

      final streamSession = HomeEventStreamSession(
        hubId: home.hubId,
        projectId: home.projectId,
        transport: buildTransport(
            home.hubId, streamUri, () => session.bearerToken()),
        runtime: runtime,
        onSnapshotRequired: () => onSnapshotRequired(home.hubId),
      );
      _streamSessions[home.hubId] = streamSession;
      await streamSession.start();
    }
  }

  Future<void> stopAllEventStreams() async {
    final sessions = _streamSessions.values.toList();
    _streamSessions.clear();
    for (final s in sessions) {
      await s.dispose();
    }
  }

  /// Registers this device's current push token for EVERY currently-authorized Home
  /// (§6: "multiple Homes") — each registration call is authenticated with THAT Home's own
  /// session, never a shared credential (§3/§10 isolation carried into push too).
  ///
  /// HONEST STATUS: real HTTP plumbing against the real server contract (proven by
  /// `mobile-auth-bridge.test.ts`'s push-registration test, server-side); calling this with no
  /// [pushTokenSource] wired (the current composition root state) is a documented no-op, not a
  /// silent failure — see [PlatformPushTokenSource]'s own doc.
  Future<void> registerPushTokenForAllHomes() async {
    final source = pushTokenSource;
    if (source == null) return; // PLATFORM STUB — nothing to register yet.
    final token = await source.currentToken();
    if (token == null) return;

    for (final home in homeController.homes) {
      final session = authStore.sessionFor(home.hubId);
      if (session == null) {
        continue; // this Home has no live session — skip, don't fabricate one.
      }
      final baseUrl = await resolveHomeBaseUrl(home.hubId);
      if (baseUrl == null) {
        continue; // can't reach this Home yet — skip, don't guess an address.
      }
      try {
        await pushClient.register(
            baseUrl: baseUrl,
            bearerToken: session.bearerToken(),
            platform: source.platform,
            token: token);
      } catch (_) {
        // Best-effort per Home — one Home's registration failing must not block the others
        // (mirrors the server's own `PushService.deliver` best-effort-per-device policy).
      }
    }
  }

  /// Ingests one raw event payload (already decoded from a push data message or another
  /// transport) for a specific Home. The platform layer (a background message handler, a
  /// foreground WSS listener once one exists) calls this — `RuntimeController` itself has no
  /// opinion on WHERE the raw payload came from, only how to turn it into a [HomeEvent] and
  /// route it through [runtime]'s isolation/dedup logic.
  bool ingestHomeEvent(HomeEvent event) => runtime.ingestEvent(event);

  void dispose() {
    homeController.removeListener(_syncAuthorizedHomes);
    unawaited(stopAllEventStreams());
    runtime.dispose();
  }
}
