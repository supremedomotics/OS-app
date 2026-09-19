/// §Phase13.1 §6 — orthogonal runtime-lifecycle dimensions (deliberately NOT one combined
/// enum, per Phase 13.0's own architectural decision): process state, UI state, per-Home
/// connectivity (`HubEventStreamState`, unchanged since Phase 12.7), and call state (unchanged
/// since Phase 12.5's `MobileRuntime`) all vary independently, and a real device is routinely in
/// a combination like "background + reconnecting" that a single flat enum can't express cleanly.
///
/// This file owns ONLY the two NEW dimensions Phase 13.1 introduces (process/UI state) — the
/// other two already exist and are reused unmodified.
library;

/// The OS process lifecycle, as reported by native code. `starting`/`restarting` are distinct:
/// `starting` is the normal cold-launch path; `restarting` is specifically "the process was
/// woken by an OS mechanism after having been fully `terminated`" (§Phase13.0 §15) — a future
/// phase's push/VoIP wake handlers report `restarting`, not `starting`, so the runtime can tell
/// the difference between "the homeowner opened the app" and "the OS woke us for an event."
enum ProcessState {
  starting,
  foreground,
  background,
  suspended,
  terminated,
  restarting,
}

/// Whether a Flutter widget tree currently exists and is visible. Deliberately distinct from
/// [ProcessState]: the Dart VM/native runtime can be `foreground` (process state) while there is
/// genuinely `noUi` (e.g. a future OS-triggered wake that runs runtime code without ever
/// building the widget tree) — conflating the two would make that state inexpressible.
enum UiState {
  noUi,
  uiActive,
  uiBackgrounded,
}

/// Parses a native event's `state` string into a [ProcessState] — the ONLY place this string
/// contract is interpreted, so the native bridge contract (§Phase13.1 §4) has one parser, not
/// one per call site. Unknown values throw rather than silently defaulting, since a native/Dart
/// contract mismatch should fail loudly during development, never resolve to a guessed state.
ProcessState parseProcessState(String raw) {
  for (final s in ProcessState.values) {
    if (s.name == raw) return s;
  }
  throw ArgumentError.value(raw, 'raw', 'Unknown ProcessState from native runtime bridge');
}

/// §Phase13.3 §"ANDROID LIFECYCLE" — a THIRD orthogonal dimension, distinct from [ProcessState]
/// (which answers "is the OS process alive") and [UiState] (which answers "does a widget tree
/// exist right now"). This answers a narrower, Android-specific question: "is the native
/// foreground Service that keeps this process alive/prioritized while backgrounded currently
/// running." Deliberately NOT folded into [ProcessState] (the phase's own explicit instruction:
/// "Do not overload ProcessState with ServiceState") — a device can be `background` (process
/// state) with the service `running` (normal backgrounded-but-connected case) OR `stopped`
/// (background with no active service, e.g. before the homeowner ever backgrounds the app, or
/// after the service failed/was stopped) — two genuinely different situations a single enum
/// value couldn't distinguish. iOS has no equivalent concept; `AndroidServiceState.stopped` is
/// this dimension's permanent, honest value on that platform (there is no Android Service to
/// report on), never fabricated as "running."
enum AndroidServiceState {
  stopped,
  starting,
  running,
  stopping,
  failed,
}

/// Same one-parser convention as [parseProcessState].
AndroidServiceState parseAndroidServiceState(String raw) {
  for (final s in AndroidServiceState.values) {
    if (s.name == raw) return s;
  }
  throw ArgumentError.value(
      raw, 'raw', 'Unknown AndroidServiceState from native runtime bridge');
}
