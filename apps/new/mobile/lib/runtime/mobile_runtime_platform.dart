import 'package:supreme_os_core/supreme_os_core.dart' show CallState;

import 'lifecycle.dart';

/// §Phase13.1 §13 — the platform-NEUTRAL capability surface the Dart runtime needs from
/// whatever OS it's running on. This is a capability interface, not a platform-shaped one:
/// nothing here mentions "ForegroundService," "PushKit," "CallKit," or any other
/// Android/iOS-specific concept (§13's explicit instruction). A real implementation
/// ([NativeRuntimeBridge]) speaks Flutter platform channels underneath; a test implementation
/// can be a plain in-memory fake — callers of this interface never know or care which.
///
/// HONEST SCOPE for Phase 13.1: only lifecycle observation and a status round-trip are
/// implemented. `requestNativeWake`/notification-registration/call-presentation methods are
/// deliberately NOT added yet (§4: "do not implement call events yet if the call subsystem does
/// not exist") — adding them now, unbacked by any real OS mechanism, would be exactly the kind
/// of "looks-implemented" surface this project's conventions forbid. Extend this interface in
/// 13.2+ by adding new methods/event types, never by repurposing an existing one.
abstract class MobileRuntimePlatform {
  /// Tells native code the Dart runtime is up and ready to receive lifecycle events. Idempotent
  /// — safe to call more than once (e.g. after a hot restart during development).
  Future<void> initialize();

  /// Reports a UI-visibility change to native code (Flutter → Native, §4). Native code uses
  /// this purely for its OWN lifecycle bookkeeping (e.g. deciding whether a future foreground
  /// service is still needed) — it has no effect on Home connectivity (§7).
  Future<void> notifyUiLifecycleChanged(UiState state);

  /// A simple, synchronous-shaped status round-trip — proves the channel itself works, and
  /// gives Professional Mode diagnostics (§19, future phase) a real value to display rather
  /// than inventing one. Returns a platform-reported [ProcessState] plus an opaque
  /// platform-version string for diagnostics.
  Future<NativeRuntimeStatus> requestRuntimeStatus();

  /// Native → Flutter events. [ProcessStateChanged] (13.1) and [ServiceStateChanged] (13.3) are
  /// emitted so far — the sealed hierarchy exists so 13.4+ can add `IncomingCallEvent`/
  /// `NotificationTappedEvent`/`CallStateChangedEvent`/`DoorReleaseResultEvent` as NEW subtypes
  /// without breaking existing listeners (§4: "extended without breaking the contract" — a
  /// `switch` on this type that doesn't handle a new subtype is a compile error the caller fixes
  /// deliberately, not a silent runtime gap).
  Stream<NativeRuntimeEvent> get events;

  /// §Phase13.3 "ANDROID FOREGROUND SERVICE" — an explicit, capability-shaped request to start
  /// whatever OS mechanism keeps this process alive/prioritized while backgrounded (a real
  /// foreground Service on Android; a documented no-op on iOS/web, since neither has an
  /// equivalent construct this phase implements — see [NoOpMobileRuntimePlatform] and
  /// `NativeRuntimeBridge`'s own iOS-side channel, which never registers a handler for this
  /// method). Never called automatically by native code on its own initiative — Dart decides
  /// when this is needed (§ "no uncontrolled always-running service").
  Future<void> startBackgroundService();

  /// Symmetric stop. Idempotent — safe to call when nothing is running.
  Future<void> stopBackgroundService();

  Future<void> dispose();
}

class NativeRuntimeStatus {
  final ProcessState processState;
  final String platformVersion;
  const NativeRuntimeStatus(
      {required this.processState, required this.platformVersion});
}

/// Base type for every native → Flutter event. See [MobileRuntimePlatform.events]'s doc for why
/// this is a class hierarchy rather than a single event-with-a-type-string shape.
sealed class NativeRuntimeEvent {
  const NativeRuntimeEvent();
}

class ProcessStateChanged extends NativeRuntimeEvent {
  final ProcessState state;
  const ProcessStateChanged(this.state);
}

/// §Phase13.3 — reports a change in the Android foreground Service's own lifecycle. Never
/// emitted on iOS/web (there is no equivalent Service there); a caller that never sees this
/// event on those platforms should assume [AndroidServiceState.stopped], never guess otherwise.
class ServiceStateChanged extends NativeRuntimeEvent {
  final AndroidServiceState state;
  const ServiceStateChanged(this.state);
}

/// §Phase13.4 — iOS's PushKit VoIP token, reported the same way APNs/FCM tokens are (via a
/// native event, never a Dart→native poll). Distinct from [PlatformPushTokenSource]'s own
/// token concept (APNs/FCM, for ordinary notifications) — VoIP push is a SEPARATE Apple token
/// namespace used ONLY to wake the app for an incoming call (§"PUSHKIT"). No server-side
/// registration route for this token exists yet (that is a future phase's job once the Hub
/// side actually sends VoIP pushes) — this phase only establishes that the token can reach
/// Dart at all.
class VoipTokenRefreshed extends NativeRuntimeEvent {
  final String token;
  const VoipTokenRefreshed(this.token);
}

/// §Phase13.4 — a real incoming SupremeOS doorphone call was JUST reported to iOS CallKit
/// (native call presentation is already showing by the time this reaches Dart — see
/// `VoipCallManager`'s own doc on why CallKit reporting can never wait for Dart). `hubId` is
/// the canonical Home this call belongs to — never a display name, never inferred by Dart,
/// always carried by the event itself (§"MULTI-HOME").
class IncomingCallEvent extends NativeRuntimeEvent {
  final String callId;
  final String hubId;
  const IncomingCallEvent({required this.callId, required this.hubId});
}

/// §Phase13.4 — CallKit reported an OS-level state change for an existing call (answer/end).
/// [state] is always a value already legal per `MobileRuntime`'s own `CallState` transition
/// table — native code emits the domain vocabulary directly (`"connecting"`, `"ended"`, ...),
/// not a CallKit-specific term, so this event never leaks a platform concept into the runtime
/// boundary's Dart consumers.
class CallStateChangedFromNative extends NativeRuntimeEvent {
  final String callId;
  final String hubId;
  final CallState state;
  const CallStateChangedFromNative(
      {required this.callId, required this.hubId, required this.state});
}

/// §Phase13.4 — CallKit's `reportNewIncomingCall` itself failed (rare — e.g. Do Not Disturb
/// policy, too many simultaneous calls). Surfaced honestly rather than silently dropped, so a
/// future phase can decide whether/how to notify the homeowner some other way.
class IncomingCallFailed extends NativeRuntimeEvent {
  final String callId;
  final String reason;
  const IncomingCallFailed({required this.callId, required this.reason});
}
