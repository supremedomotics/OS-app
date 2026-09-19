import 'dart:async';

import 'event_dedup.dart';
import 'home_event.dart';

/// Legal [CallState] transitions (§4) — enforced so a platform bug (a duplicate push, an
/// out-of-order CallKit/PushKit callback) can never move a call session backward into a state
/// that implies something happened which didn't (e.g. `ended` → `connected`).
const Map<CallState, Set<CallState>> _legalCallTransitions = {
  CallState.idle: {CallState.incoming},
  CallState.incoming: {CallState.ringing, CallState.ended, CallState.failed},
  CallState.ringing: {
    CallState.connecting,
    CallState.ending,
    CallState.ended,
    CallState.failed
  },
  CallState.connecting: {
    CallState.connected,
    CallState.failed,
    CallState.ending
  },
  CallState.connected: {CallState.ending, CallState.failed},
  CallState.ending: {CallState.ended},
  CallState.ended: {},
  CallState.failed: {},
};

/// The SupremeOS Mobile Runtime (§Phase12.5) — the background-capable, Flutter-widget-lifecycle
/// -independent core responsible for residential events (§2's architecture diagram). This class
/// itself is pure Dart and holds no platform API; it is driven by whatever the platform layer
/// (a Flutter `RuntimeController`, a background isolate, a native callback bridge) feeds it via
/// [ingestRawEvent]/[updateAuthorizedHomes], and its outputs (`events`, `callUpdates`) are
/// consumed identically whether the app is foregrounded or not — closing a screen does not
/// dispose this object (§2: "closing a screen must not terminate residential background
/// responsibilities" — enforced by NOT being a widget/State in the first place).
///
/// Multi-Home aware by construction (§3): every ingested event is checked against
/// [authorizedHubIds] before being surfaced — an event for a Home this Mobile isn't authorized
/// for (a forged push, a stale registration) is dropped, never surfaced as if authorized. A
/// background event is surfaced regardless of which Home is currently selected in the UI
/// (§3: "the runtime must be able to receive and surface the Home A call/event" while the UI
/// shows Home B) — this class has no concept of "active Home" at all; that distinction belongs
/// to the UI layer (`activeHomeIdProvider`), deliberately kept separate.
class MobileRuntime {
  final SeenEventTracker _dedup;
  Set<String> _authorizedHubIds = {};

  final _eventsController = StreamController<HomeEvent>.broadcast();
  final _callsController = StreamController<CallSession>.broadcast();
  final Map<String, CallSession> _activeCalls = {};

  MobileRuntime({SeenEventTracker? dedup})
      : _dedup = dedup ?? SeenEventTracker();

  /// Real residential events, already deduplicated and Home-isolation-checked. The UI (or a
  /// notification-mapping layer) subscribes to this to build homeowner-facing surfaces.
  Stream<HomeEvent> get events => _eventsController.stream;

  /// Real call-session state transitions, same isolation guarantees as [events].
  Stream<CallSession> get callUpdates => _callsController.stream;

  CallSession? activeCall(String callId) => _activeCalls[callId];
  List<CallSession> get activeCalls => List.unmodifiable(_activeCalls.values);

  /// Call whenever the set of authorized Homes changes (Home paired/removed, revoked) — kept in
  /// sync with `PairedHomeManager.homes` by the platform layer, never duplicated here (§8: "do
  /// not duplicate credentials" — this only holds the identity set, never a token).
  void updateAuthorizedHomes(Iterable<String> hubIds) {
    _authorizedHubIds = hubIds.toSet();
  }

  bool isAuthorizedForHub(String hubId) => _authorizedHubIds.contains(hubId);

  /// Ingests one already-parsed [HomeEvent] (the platform layer is responsible for turning a
  /// raw push/data payload into this shape — see `RuntimeController` in `apps/new/mobile`).
  /// Returns true if the event was accepted and surfaced, false if it was dropped (unauthorized
  /// Home, or a duplicate already processed) — never throws, since a malformed/duplicate/
  /// unauthorized event is an expected, handled case, not an exceptional one (§14).
  bool ingestEvent(HomeEvent event) {
    if (!isAuthorizedForHub(event.hubId))
      return false; // §3/§10 — never surfaced
    if (!_dedup.markIfNew(event)) return false; // §13
    _eventsController.add(event);
    return true;
  }

  /// Starts (or re-surfaces, if already tracked) an incoming call session. Rejects a session
  /// for a Home this Mobile isn't authorized for, same as [ingestEvent].
  bool ingestIncomingCall(CallSession session) {
    if (!isAuthorizedForHub(session.hubId)) return false;
    if (session.state != CallState.incoming) {
      throw ArgumentError('a call session must start in CallState.incoming');
    }
    _activeCalls[session.callId] = session;
    _callsController.add(session);
    return true;
  }

  /// Transitions an existing call to [next], enforcing the legal state machine (§4). Throws
  /// [StateError] for an unknown call id or an illegal transition — a caller (platform
  /// CallKit/telecom callback) driving the state machine incorrectly is a real bug that should
  /// surface loudly, not be silently swallowed into a wrong state.
  CallSession transitionCall(String callId, CallState next) {
    final current = _activeCalls[callId];
    if (current == null) throw StateError('unknown call session: $callId');
    final legal = _legalCallTransitions[current.state] ?? const {};
    if (!legal.contains(next)) {
      throw StateError(
          'illegal call transition ${current.state.name} -> ${next.name}');
    }
    final updated = current.copyWith(state: next);
    _activeCalls[callId] = updated;
    _callsController.add(updated);
    if (next == CallState.ended || next == CallState.failed) {
      _activeCalls.remove(callId);
    }
    return updated;
  }

  Future<void> dispose() async {
    await _eventsController.close();
    await _callsController.close();
  }
}
