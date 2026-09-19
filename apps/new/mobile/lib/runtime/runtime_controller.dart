import 'dart:async';

import 'package:supreme_os_core/supreme_os_core.dart';

import '../features/settings/paired_home_controller.dart';
import 'lifecycle.dart';

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
  /// §Phase13.2 §2 — must be called once before [currentToken]/[onTokenRefresh] are used.
  /// Real implementations do platform init here (e.g. `Firebase.initializeApp()` on Android);
  /// idempotent, safe to call more than once.
  Future<void> initialize();

  Future<String?> currentToken();
  Stream<String> get onTokenRefresh;
  String get platform; // "fcm" | "apns"

  /// §Phase13.2 §5/§6 — a raw, already-decoded push `data` payload received while THIS
  /// platform source's native side has a live engine to forward through (see
  /// `NativePushTokenSource`'s own HONEST SCOPE LIMIT doc — a fully backgrounded/terminated
  /// app is NOT covered by this phase). The composition root routes this into
  /// `RuntimeController.ingestPushPayload`; this interface has no opinion on WHAT the payload
  /// means, only that it arrived.
  Stream<Map<String, dynamic>> get onPushReceived;

  /// §Phase13.2 §2 — releases whatever platform resources [initialize] acquired (stream
  /// subscriptions, etc.). Called when the owning [RuntimeController] is disposed.
  Future<void> dispose();
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

  /// §Phase13.1 §6/§7 — the two lifecycle dimensions Phase 13.1 introduces, fed by the native
  /// runtime bridge (`NativeRuntimeBridge`) and Flutter's own `WidgetsBindingObserver`
  /// respectively. Recording ONLY: per §7's explicit instruction, entering background/no-UI
  /// does NOT change Home connectivity semantics here — `ConnectionManager`/
  /// `HomeEventStreamSession` keep behaving exactly as they did in Phase 12, unaffected by these
  /// fields. A future phase (13.2/13.3) is what actually ACTS on these values (e.g. deciding
  /// whether to keep a stream open under a foreground service) — this phase only establishes
  /// that the information can reach the Dart runtime without a parallel state authority.
  ProcessState _processState = ProcessState.starting;
  UiState _uiState = UiState.noUi;
  /// §Phase13.3 — a THIRD, orthogonal dimension: whether Android's native foreground Service is
  /// currently running. Permanently `stopped` on iOS/web (no equivalent construct exists there
  /// this phase) — see `lifecycle.dart`'s own doc on why this is never folded into
  /// [processState]. Recording only, same policy as the other two dimensions.
  AndroidServiceState _androidServiceState = AndroidServiceState.stopped;
  final _lifecycleController = StreamController<void>.broadcast();

  ProcessState get processState => _processState;
  UiState get uiState => _uiState;
  AndroidServiceState get androidServiceState => _androidServiceState;

  /// Fires whenever [processState], [uiState], or [androidServiceState] changes — the
  /// UI/diagnostics layer's only hook into these fields; nothing in the connectivity/runtime
  /// pipeline subscribes to this (see the class doc above for why).
  Stream<void> get lifecycleChanges => _lifecycleController.stream;

  void updateProcessState(ProcessState state) {
    if (_processState == state) return; // no duplicate lifecycle events (§14)
    _processState = state;
    _lifecycleController.add(null);
  }

  void updateAndroidServiceState(AndroidServiceState state) {
    if (_androidServiceState == state) return; // no duplicate lifecycle events
    _androidServiceState = state;
    _lifecycleController.add(null);
  }

  void updateUiState(UiState state) {
    if (_uiState == state) return; // no duplicate lifecycle events (§14)
    _uiState = state;
    _lifecycleController.add(null);
  }

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
    await source.initialize(); // idempotent — safe even if already initialized.
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

  /// §Phase13.2 §2/§3 — the unregister half of the token lifecycle, symmetric with
  /// [registerPushTokenForAllHomes]: removes THIS device's current token from ONE specific
  /// Home only, authenticated with that Home's own session — never a shared credential, and
  /// never capable of affecting another Home's registration (there is no cross-Home token
  /// store on the client, and the server route is scoped per-Hub-process, see
  /// `PushRegistrationClient`'s own doc).
  Future<void> unregisterPushTokenForHome(String hubId) async {
    final source = pushTokenSource;
    if (source == null) return;
    final token = await source.currentToken();
    if (token == null) return;
    final session = authStore.sessionFor(hubId);
    if (session == null) return; // no live session for this Home — nothing to authenticate with.
    final baseUrl = await resolveHomeBaseUrl(hubId);
    if (baseUrl == null) return;
    try {
      await pushClient.unregister(
          baseUrl: baseUrl, bearerToken: session.bearerToken(), token: token);
    } catch (_) {
      // Best-effort, same policy as registration.
    }
  }

  /// Ingests one raw event payload (already decoded from a push data message or another
  /// transport) for a specific Home. The platform layer (a background message handler, a
  /// foreground WSS listener once one exists) calls this — `RuntimeController` itself has no
  /// opinion on WHERE the raw payload came from, only how to turn it into a [HomeEvent] and
  /// route it through [runtime]'s isolation/dedup logic.
  bool ingestHomeEvent(HomeEvent event) => runtime.ingestEvent(event);

  /// §Phase13.2 §7/§8 — ingests a raw, already-decoded push `data` payload (the platform
  /// layer's push-received callback calls this). Parses it via [mapPushEnvelopeToHomeEvent]
  /// (drops a malformed/incomplete payload rather than throwing — §12 "unknown push event") and
  /// routes the result through the EXACT SAME [runtime] pipeline a live WebSocket event uses —
  /// same hub-authorization isolation, same `(hubId, eventId)` dedup, no second dedup system.
  /// Returns `false` for a malformed payload OR a duplicate — callers that care which can
  /// inspect [mapPushEnvelopeToHomeEvent] themselves; this method's only job is "was this a new,
  /// authorized event."
  bool ingestPushPayload(Map<String, dynamic> data) {
    final event = mapPushEnvelopeToHomeEvent(data);
    if (event == null) return false;
    return runtime.ingestEvent(event);
  }

  /// §Phase13.4 — a real CallKit incoming-call report already reached the OS (native
  /// presentation is already showing) reaches Dart here. Builds the initial
  /// [CallSession] (always `CallState.incoming`, per [MobileRuntime.ingestIncomingCall]'s own
  /// contract) and routes it through the SAME hub-authorization check every other event uses —
  /// a call for a Home this Mobile is no longer authorized for (revoked mid-flight) is dropped,
  /// never surfaced (§"MULTI-HOME"/security). Never touches any transport/command path — this
  /// method's only job is recording the call's existence in [runtime].
  bool handleIncomingCall({required String hubId, required String callId}) {
    final session = CallSession(
      callId: callId,
      hubId: hubId,
      projectId: '', // not carried by the VoIP envelope — see mapPushEnvelopeToHomeEvent's
      // identical documented simplification; real callers resolve display context via
      // PairedHomeController by this same canonical hubId, never from the call payload.
      media: CallMedia.voice,
      state: CallState.incoming,
      startedAt: DateTime.now(),
    );
    return runtime.ingestIncomingCall(session);
  }

  /// §Phase13.4 — a real OS-level call-state change (CallKit answer/end) reaches Dart here.
  /// Delegates entirely to [MobileRuntime.transitionCall]'s own legal-transition enforcement;
  /// an illegal or unknown-call transition from a native bridge is dropped rather than thrown
  /// (§"malformed/duplicate" boundary-hardening policy — a version-skewed or duplicate native
  /// callback must never crash the app, even though a DIRECT caller of `transitionCall` is
  /// still held to its stricter throw-on-bug contract). Deliberately does NOT call any HTTP
  /// client, command path, or door-release API — answering a call never executes a Hub command
  /// (§"ANSWERING A CALL").
  bool handleNativeCallStateChange({required String callId, required CallState state}) {
    try {
      runtime.transitionCall(callId, state);
      return true;
    } on StateError {
      return false;
    }
  }

  void dispose() {
    homeController.removeListener(_syncAuthorizedHomes);
    unawaited(stopAllEventStreams());
    runtime.dispose();
    unawaited(_lifecycleController.close());
    unawaited(pushTokenSource?.dispose());
  }
}
