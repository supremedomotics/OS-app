/// What authoritative device state proves that a command took effect (§ command lifecycle:
/// a requested value is only ever *confirmed* by a device report that satisfies this).
///
/// One function serves two readers, so they can never disagree: the `CommandTracker` (did my
/// command land?) and `experienceStatus` (does the residence match this Experience's authored
/// steps?). A Hub `SceneStep.values` IS a command, so the same mapping applies.
///
/// Only capabilities whose command has an observable state counterpart are verifiable. Anything
/// else returns null and the UI must not offer it as a confirmed control (§ never fabricate).
library;

typedef StateCheck = bool Function(Map<String, dynamic> state);

class StateExpectation {
  final String capability;
  final StateCheck matches;

  /// Plain description for logs/tests — never shown to a homeowner.
  final String description;
  const StateExpectation(this.capability, this.matches, this.description);
}

num? _n(Object? v) => v is num ? v : null;

StateExpectation? expectationOf(String capability, Map<String, dynamic> cmd) {
  final action = cmd['action'] as String?;
  switch (capability) {
    case 'onoff':
      if (action == 'on') {
        return StateExpectation(capability, (s) => s['on'] == true, 'on');
      }
      if (action == 'off') {
        return StateExpectation(capability, (s) => s['on'] == false, 'off');
      }
      return null; // toggle: the target depends on prior state — not a verifiable target.
    case 'brightness':
      if (action == 'on') {
        return StateExpectation(capability, (s) => s['on'] == true, 'on');
      }
      if (action == 'off') {
        return StateExpectation(capability, (s) => s['on'] == false, 'off');
      }
      final level = _n(cmd['level']);
      if (action == 'set' && level != null) {
        return StateExpectation(
          capability,
          (s) => level <= 0
              ? s['on'] == false || (_n(s['level']) ?? 100) <= 0
              : s['on'] == true &&
                  ((_n(s['level']) ?? -100) - level).abs() <= 2,
          'level $level',
        );
      }
      return null;
    case 'position':
      final target = switch (action) {
        'open' => 100,
        'close' => 0,
        'set' => _n(cmd['position']),
        _ => null, // stop has no target position.
      };
      if (target == null) return null;
      return StateExpectation(
        capability,
        (s) =>
            s['moving'] != true &&
            ((_n(s['position']) ?? -100) - target).abs() <= 2,
        'position $target',
      );
    case 'temperature':
      final t = _n(cmd['targetC']);
      final mode = cmd['mode'] as String?;
      if (t == null && mode == null) return null;
      return StateExpectation(
        capability,
        (s) =>
            (t == null ||
                (_n(s['targetC']) != null &&
                    (_n(s['targetC'])! - t).abs() < 0.26)) &&
            (mode == null || s['mode'] == mode),
        'target ${t ?? '-'} mode ${mode ?? '-'}',
      );
    case 'media':
      switch (action) {
        case 'play':
          return StateExpectation(
              capability, (s) => s['playback'] == 'playing', 'playing');
        case 'pause':
          return StateExpectation(
              capability, (s) => s['playback'] == 'paused', 'paused');
        case 'stop':
          return StateExpectation(
              capability,
              (s) => s['playback'] == 'stopped' || s['playback'] == 'idle',
              'stopped');
        case 'volume':
          final v = _n(cmd['volume']);
          if (v == null) return null;
          return StateExpectation(
              capability,
              (s) =>
                  _n(s['volume']) != null && (_n(s['volume'])! - v).abs() <= 1,
              'volume $v');
        case 'mute':
          return StateExpectation(
              capability, (s) => s['muted'] == true, 'muted');
        case 'unmute':
          return StateExpectation(
              capability, (s) => s['muted'] == false, 'unmuted');
      }
      return null;
  }
  return null;
}
