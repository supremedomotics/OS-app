/// What an Experience will change, and how far the residence has got (Golden Master
/// `experiences.js` "What changes" / "Where"): derived from the Hub's authored steps and the
/// devices' reported state — never from what was pressed.
///
/// The Golden Master has authored words for an Experience ("Soft, warm light and quiet music",
/// "Soft, warm" per system). The Hub's `Scene` carries none (flagged), so every phrase here is
/// derived from the step targets themselves ("Set to 30 %"), which is all that can be said truly.
library;

import '../experiences.dart';
import 'command_tracker.dart';
import 'experience_status.dart';
import 'residence_description.dart';
import 'residence_state.dart';
import 'state_expectation.dart';

enum PreviewSystem { lighting, shades, climate, music }

class EffectRow {
  final PreviewSystem system;
  final String label;
  final String effect;

  /// "3 lights" — the noun agrees with the count.
  final String count;
  final int total;
  final int arrived;
  final int changing;
  final int unreachable;
  const EffectRow(this.system, this.label, this.effect, this.count, this.total,
      this.arrived, this.changing, this.unreachable);
  bool get allArrived => arrived == total;
}

PreviewSystem? _systemOf(String capability) => switch (capability) {
      'onoff' || 'brightness' || 'color' => PreviewSystem.lighting,
      'position' => PreviewSystem.shades,
      'temperature' => PreviewSystem.climate,
      'media' => PreviewSystem.music,
      _ => null,
    };

const _label = {
  PreviewSystem.lighting: 'Lighting',
  PreviewSystem.shades: 'Shades',
  PreviewSystem.climate: 'Climate',
  PreviewSystem.music: 'Music',
};

String _noun(PreviewSystem s, int n) => switch (s) {
      PreviewSystem.lighting => n == 1 ? 'light' : 'lights',
      PreviewSystem.shades => n == 1 ? 'curtain or shade' : 'curtains and shades',
      PreviewSystem.climate => n == 1 ? 'climate zone' : 'climate zones',
      PreviewSystem.music => n == 1 ? 'music zone' : 'music zones',
    };

String _effect(PreviewSystem sys, List<ExperienceStep> steps) {
  switch (sys) {
    case PreviewSystem.lighting:
      final levels = <num>{};
      var anyOn = false, anyOff = false;
      for (final s in steps) {
        final a = s.values['action'];
        if (a == 'off') {
          anyOff = true;
        } else if (a == 'set' && s.values['level'] is num) {
          final l = s.values['level'] as num;
          if (l <= 0) {
            anyOff = true;
          } else {
            levels.add(l);
          }
        } else {
          anyOn = true;
        }
      }
      if (levels.isEmpty) return anyOn && !anyOff ? 'On' : anyOff && !anyOn ? 'Off' : 'On and off';
      final lo = levels.reduce((a, b) => a < b ? a : b);
      final hi = levels.reduce((a, b) => a > b ? a : b);
      return lo == hi ? 'Set to ${lo.round()}%' : 'Set to ${lo.round()}–${hi.round()}%';
    case PreviewSystem.shades:
      final ps = <num>{
        for (final s in steps)
          switch (s.values['action']) {
            'open' => 100,
            'close' => 0,
            _ => (s.values['position'] as num?) ?? 0,
          }
      };
      if (ps.length == 1) {
        final p = ps.first;
        return p >= 100 ? 'Open' : p <= 0 ? 'Closed' : 'Set to ${p.round()}% open';
      }
      return 'Set to ${ps.reduce((a, b) => a < b ? a : b).round()}–${ps.reduce((a, b) => a > b ? a : b).round()}% open';
    case PreviewSystem.climate:
      final ts = <num>{
        for (final s in steps)
          if (s.values['targetC'] is num) s.values['targetC'] as num
      };
      final modes = {for (final s in steps) if (s.values['mode'] != null) s.values['mode']};
      if (ts.isNotEmpty) {
        return ts.length == 1
            ? 'Set to ${fmtTemp(ts.first)}'
            : 'Set to ${fmtTemp(ts.reduce((a, b) => a < b ? a : b))} – ${fmtTemp(ts.reduce((a, b) => a > b ? a : b))}';
      }
      return modes.length == 1 ? (modes.first == 'off' ? 'Off' : 'On') : 'Adjusted';
    case PreviewSystem.music:
      final acts = {for (final s in steps) s.values['action']};
      if (acts.length == 1) {
        return switch (acts.first) {
          'play' => 'Play',
          'pause' => 'Pause',
          'stop' => 'Stop',
          'volume' => 'Volume ${((steps.first.values['volume'] as num?) ?? 0).round()}%',
          'mute' => 'Muted',
          'unmute' => 'Unmuted',
          _ => 'Adjusted',
        };
      }
      return 'Adjusted';
  }
}

/// One row per system the Experience touches, in a fixed order, for [spaceId] or the residence.
List<EffectRow> experiencePreview(
  Experience e,
  ResidenceSnapshot s, {
  Iterable<CommandRecord> commands = const [],
  String? spaceId,
}) {
  final rows = <EffectRow>[];
  for (final sys in PreviewSystem.values) {
    final steps = [
      for (final st in e.steps)
        if (_systemOf(st.capability) == sys &&
            expectationOf(st.capability, st.values) != null &&
            (spaceId == null || s.devices[st.deviceId]?.roomId == spaceId))
          st
    ];
    if (steps.isEmpty) continue;
    var arrived = 0, changing = 0, unreachable = 0;
    for (final st in steps) {
      final d = s.devices[st.deviceId];
      if (d == null || !d.isOnline) {
        unreachable++;
        continue;
      }
      final now = d.state[st.capability];
      final ok = now != null && expectationOf(st.capability, st.values)!.matches(now);
      if (ok) {
        arrived++;
      } else if (commands.any((c) =>
          c.inFlight && c.deviceId == st.deviceId && c.capability == st.capability)) {
        changing++;
      }
    }
    rows.add(EffectRow(sys, _label[sys]!, _effect(sys, steps),
        '${steps.length} ${_noun(sys, steps.length)}', steps.length, arrived, changing, unreachable));
  }
  return rows;
}

/// The light the residence will be in when this Experience has taken effect — what the hero
/// shows before it is set ("Relax, Focus and Movie look different before they are set").
RoomLight intendedLight(Experience e, ResidenceSnapshot s, {String? spaceId}) {
  var total = 0, on = 0;
  final levels = <num>[];
  for (final st in e.steps) {
    if (_systemOf(st.capability) != PreviewSystem.lighting) continue;
    if (spaceId != null && s.devices[st.deviceId]?.roomId != spaceId) continue;
    total++;
    final a = st.values['action'];
    final l = st.values['level'];
    final off = a == 'off' || (a == 'set' && l is num && l <= 0);
    if (!off) {
      on++;
      levels.add(l is num ? l : 100);
    }
  }
  return RoomLight(
      lightsTotal: total,
      lightsOn: on,
      level: levels.isEmpty ? 0 : (levels.reduce((a, b) => a + b) / levels.length).round(),
      kelvin: null);
}

/// The Experience's one line, derived: "Changes lighting, curtains and music."
String experienceLine(Experience e, ResidenceSnapshot s, {String? spaceId}) {
  final rows = experiencePreview(e, s, spaceId: spaceId);
  if (rows.isEmpty) return '';
  final names = [
    for (final r in rows)
      switch (r.system) {
        PreviewSystem.lighting => 'lighting',
        PreviewSystem.shades => 'curtains',
        PreviewSystem.climate => 'climate',
        PreviewSystem.music => 'music',
      }
  ];
  final list = names.length < 2
      ? names.join()
      : '${names.sublist(0, names.length - 1).join(', ')} and ${names.last}';
  return 'Changes $list.';
}

/// The Golden Master's status words, from the derived phase.
String experienceStatusText(ExperienceStatus st) => switch (st.phase) {
      ExperiencePhase.active => 'Active now',
      ExperiencePhase.partial => st.unreachable > 0
          ? 'Partially active · ${st.unreachable} not responding'
          : 'Partially active',
      ExperiencePhase.becoming => 'Becoming…',
      ExperiencePhase.unavailable => 'Unavailable right now',
      ExperiencePhase.inactive => 'Not active',
      ExperiencePhase.indeterminate => '',
    };
