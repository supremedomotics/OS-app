/// Homeowner language for the residence — the Golden Master's `derive.js` (`condition`, `home`,
/// `residence`) ported onto production capability states and the ONE Residence State.
///
/// Pure functions of [ResidenceSnapshot] (+ in-flight commands + the hour): nothing here stores
/// anything, so Home, Spaces, Space, the watch glance and the room panel can never describe the
/// same residence differently.
///
/// Where the Golden Master leans on a signal production does not have, this file says less
/// instead of inventing it — see the DIVERGENCES block. Each is a flagged backend/model gap, not
/// a design choice.
///
/// DIVERGENCES (all deliberate, all flagged in docs/design/golden-master-implementation-map.md):
///  * No occupancy / arming / contact signal exists in the contract → no "Occupied", no
///    "Secure/Protected", no protection attention items.
///  * Dimmers report no colour temperature → no "warm"/"cool" claim unless a `color` capability
///    reports `kelvin`.
///  * The residence has no readable time zone / location (only a write route) → the hour of
///    the device stands in for the residence's own clock.
///  * `Room` has no grammatical-preposition field → a small name rule picks "in the"/"on the".
library;

import '../experiences.dart';
import '../semantic_model.dart';
import 'command_tracker.dart';
import 'experience_status.dart';
import 'residence_state.dart';

// ── aggregates over confirmed device state ────────────────────────────────────────────────

class RoomLight {
  final int lightsTotal;
  final int lightsOn;

  /// Mean brightness of the lights that are on (100 for an on/off-only light). 0 when none is on.
  final int level;

  /// Mean colour temperature of lit lights that REPORT one; null when none does.
  final int? kelvin;
  const RoomLight(
      {required this.lightsTotal,
      required this.lightsOn,
      required this.level,
      required this.kelvin});
  bool get on => lightsOn > 0;
}

/// A light is a device that dims, colours, or is typed as a light and switches.
bool _isLight(DeviceRecord d) =>
    d.capabilities.containsKey('brightness') ||
    d.capabilities.containsKey('color') ||
    (d.capabilities.containsKey('onoff') &&
        (d.supremeType == 'light' ||
            d.supremeType == 'dimmer' ||
            d.supremeType == 'color_light'));

bool _lightIsOn(DeviceRecord d) {
  if (!d.isOnline) return false;
  final b = d.state['brightness'];
  if (b != null) return b['on'] == true;
  final c = d.state['color'];
  if (c != null) return c['on'] == true;
  return d.state['onoff']?['on'] == true;
}

int _lightLevel(DeviceRecord d) {
  final b = d.state['brightness'];
  if (b != null) return (b['level'] as num?)?.toInt() ?? 100;
  final c = d.state['color'];
  if (c != null) return (c['level'] as num?)?.toInt() ?? 100;
  return 100;
}

RoomLight lightOf(Iterable<DeviceRecord> devices) {
  final lights = devices.where(_isLight).toList();
  final on = lights.where(_lightIsOn).toList();
  final level = on.isEmpty
      ? 0
      : (on.map(_lightLevel).reduce((a, b) => a + b) / on.length).round();
  final ks = [
    for (final d in on)
      if ((d.state['color']?['kelvin'] as num?) != null)
        (d.state['color']!['kelvin'] as num).toInt()
  ];
  final kelvin = ks.isEmpty
      ? null
      : ((ks.reduce((a, b) => a + b) / ks.length) / 100).round() * 100;
  return RoomLight(
      lightsTotal: lights.length,
      lightsOn: on.length,
      level: level,
      kelvin: kelvin);
}

DeviceRecord? _first(Iterable<DeviceRecord> ds, String cap) {
  for (final d in ds) {
    if (d.capabilities.containsKey(cap)) return d;
  }
  return null;
}

bool _playing(DeviceRecord? d) =>
    d != null && d.isOnline && d.state['media']?['playback'] == 'playing';

String fmtTemp(num t) => '${(t * 10).round() / 10}'.replaceAllMapped(
        RegExp(r'^(-?\d+)$'), (m) => '${m[1]}.0') +
    '°';

// ── Experiences in effect ─────────────────────────────────────────────────────────────────

/// The Experience currently in effect in a space — derived (all its steps satisfied), never
/// remembered. Home-scope Experiences count for a space when one of their steps acts there.
Experience? activeExperienceIn(ResidenceSnapshot s, String spaceId,
    {Iterable<CommandRecord> commands = const []}) {
  Experience? best;
  var bestMatched = -1;
  for (final e in s.experiences) {
    final touches = e.spaceIds.contains(spaceId) ||
        e.steps.any((st) => s.devices[st.deviceId]?.roomId == spaceId);
    if (!touches) continue;
    final st = experienceStatus(e, s, commands: commands);
    if (st.phase == ExperiencePhase.active && st.matched > bestMatched) {
      best = e;
      bestMatched = st.matched;
    }
  }
  return best;
}

Experience? activeExperienceInResidence(ResidenceSnapshot s,
    {Iterable<CommandRecord> commands = const []}) {
  Experience? best;
  var bestMatched = -1;
  for (final e in s.experiences) {
    final st = experienceStatus(e, s, commands: commands);
    if (st.phase == ExperiencePhase.active && st.matched > bestMatched) {
      best = e;
      bestMatched = st.matched;
    }
  }
  return best;
}

// ── a space ───────────────────────────────────────────────────────────────────────────────

class SpaceCondition {
  /// The minimum meaningful words — never device counts (e.g. `Warm light`, `Music`).
  final List<String> words;

  /// "1 not responding" — only when something genuinely is not.
  final String? attention;
  final Experience? experience;

  /// A command toward a device in this space is still in flight.
  final bool adjusting;
  const SpaceCondition(
      {required this.words,
      required this.attention,
      required this.experience,
      required this.adjusting});
  String get line => words.join(' · ');
}

SpaceCondition spaceCondition(
  ResidenceSnapshot s,
  String spaceId, {
  Iterable<CommandRecord> commands = const [],
  bool sunUp = true,
}) {
  final ds = s.devicesIn(spaceId);
  final light = lightOf(ds);
  String? lightWords;
  if (light.lightsTotal > 0) {
    if (!light.on) {
      lightWords = sunUp ? 'Daylight only' : 'Dark';
    } else {
      final k = light.kelvin;
      final l = light.level;
      final tone = k == null ? null : (k <= 3200 ? 'warm' : k <= 4200 ? 'soft white' : 'cool');
      lightWords = l < 30
          ? (tone == null ? 'Low light' : 'Low, $tone light')
          : '${l >= 80 ? 'Bright ' : ''}${tone == null ? (l >= 80 ? 'light' : 'Lights on') : '$tone light'}';
      lightWords = lightWords[0].toUpperCase() + lightWords.substring(1);
    }
  }
  final audio = _first(ds, 'media');
  final sound = _playing(audio) ? 'Music' : null;
  String? climate;
  final c = _first(ds, 'temperature');
  final t = c?.state['temperature'];
  if (c != null && c.isOnline && t != null && t['mode'] != 'off') {
    final amb = t['ambientC'] as num?, tgt = t['targetC'] as num?;
    if (amb != null && tgt != null && (amb - tgt).abs() >= 1.5) {
      climate = '${amb < tgt ? 'Warming' : 'Cooling'} to ${fmtTemp(tgt)}';
    }
  }
  final offline = ds.where((d) => !d.isOnline).length;
  final inFlight = commands.any(
      (c) => c.inFlight && s.devices[c.deviceId]?.roomId == spaceId);
  return SpaceCondition(
    words: [
      if (lightWords != null) lightWords,
      if (sound != null) sound,
      if (climate != null) climate,
    ],
    attention: offline > 0 ? '$offline not responding' : null,
    experience: activeExperienceIn(s, spaceId, commands: commands),
    adjusting: inFlight,
  );
}

// ── the residence (Home) ──────────────────────────────────────────────────────────────────

enum PartOfDay { morning, midday, afternoon, evening, night }

PartOfDay partOfDay(int hour) => hour < 5
    ? PartOfDay.night
    : hour < 12
        ? PartOfDay.morning
        : hour < 14
            ? PartOfDay.midday
            : hour < 17
                ? PartOfDay.afternoon
                : hour < 22
                    ? PartOfDay.evening
                    : PartOfDay.night;

String salutation(int hour) => hour < 5
    ? 'Good night'
    : hour < 12
        ? 'Good morning'
        : hour < 18
            ? 'Good afternoon'
            : 'Good evening';

class HomeDescription {
  /// The one sentence Home says.
  final String sentence;

  /// A few quiet signals (light · temperature · sound).
  final List<String> signals;
  final Experience? experience;

  /// A quieter note about what is not responding; null when nothing is out.
  final String? note;

  /// A command is still in flight somewhere — Home says "Adjusting the residence…".
  final bool adjusting;
  const HomeDescription(
      {required this.sentence,
      required this.signals,
      required this.experience,
      required this.note,
      required this.adjusting});
}

const _onTheNames = ['terrace', 'balcony', 'deck', 'roof', 'patio', 'porch'];

/// "in the living room" / "on the terrace" — see DIVERGENCES.
String spaceAt(String name) {
  final l = name.toLowerCase();
  return '${_onTheNames.any(l.contains) ? 'on' : 'in'} the $l';
}

String _isnt(String name) {
  final l = name.toLowerCase();
  return l.endsWith('s') && !l.endsWith('ss') ? 'aren’t' : 'isn’t';
}

String _list(List<String> a) => a.length < 2
    ? a.join()
    : '${a.sublist(0, a.length - 1).join(', ')} and ${a.last}';

HomeDescription describeHome(
  ResidenceSnapshot s, {
  required int hour,
  Iterable<CommandRecord> commands = const [],
}) {
  final all = s.devices.values.toList();
  final online = all.where((d) => d.isOnline).toList();
  final pod = partOfDay(hour);
  final lit = online.where((d) => _isLight(d) && _lightIsOn(d)).toList();
  final lvl = lit.isEmpty
      ? 0
      : lit.map(_lightLevel).reduce((a, b) => a + b) / lit.length;
  final ks = [
    for (final d in lit)
      if ((d.state['color']?['kelvin'] as num?) != null)
        (d.state['color']!['kelvin'] as num).toInt()
  ];
  final k = ks.isEmpty ? null : ks.reduce((a, b) => a + b) / ks.length;
  final podWord = switch (pod) {
    PartOfDay.morning || PartOfDay.midday || PartOfDay.afternoon => 'daylight',
    PartOfDay.evening => 'evening light',
    PartOfDay.night => 'night light',
  };
  final podPlain = switch (pod) {
    PartOfDay.midday => 'midday',
    _ => pod.name,
  };
  final light = lit.isEmpty
      ? 'Lights off'
      : lvl >= 75
          ? 'Bright $podWord'
          : '${lvl < 45 ? 'Soft' : k == null ? '' : (k <= 3200 ? 'Warm' : 'Clear')} $podPlain light'
              .trim()
              .replaceFirstMapped(RegExp(r'^(\w)'), (m) => m[1]!.toUpperCase());

  final temps = [
    for (final d in online)
      if ((d.state['temperature']?['ambientC'] as num?) != null)
        (d.state['temperature']!['ambientC'] as num).toDouble()
  ];
  final temp =
      temps.isEmpty ? null : fmtTemp(temps.reduce((a, b) => a + b) / temps.length);

  final music = [
    for (final d in online)
      if (_playing(d)) d
  ];
  final musicSpaces = <Space>[
    for (final id in {for (final d in music) d.roomId})
      if (id != null && s.space(id) != null) s.space(id)!
  ];
  final sound = musicSpaces.length == 1
      ? 'Music ${spaceAt(musicSpaces.first.name)}'
      : musicSpaces.length > 1
          ? 'Music in ${musicSpaces.length} spaces'
          : 'Quiet';

  final offline = all.where((d) => !d.isOnline).toList();
  final note = offline.isEmpty
      ? null
      : offline.length == 1
          ? 'The ${offline.first.name.toLowerCase()} ${_isnt(offline.first.name)} responding.'
          : '${offline.length} devices aren’t responding.';
  final exceptWhere = offline.length == 1
      ? 'the ${offline.first.name.toLowerCase()}'
      : _list([
          for (final id in {for (final d in offline) d.roomId})
            'the ${(id == null ? null : s.space(id)?.name)?.toLowerCase() ?? 'residence'}'
        ]);

  final pending = commands.any((c) => c.inFlight);
  final quiet = lit.isEmpty && music.isEmpty && pod == PartOfDay.night;
  final sentence = pending
      ? 'Adjusting the residence…'
      : note != null
          ? '${quiet ? 'Resting, ' : 'Settled, '}except $exceptWhere.'
          : quiet
              ? 'The residence is resting.'
              : 'Everything is settled.';

  return HomeDescription(
    sentence: sentence,
    signals: [light, if (temp != null) temp, sound],
    experience: activeExperienceInResidence(s, commands: commands),
    note: note,
    adjusting: pending,
  );
}

/// A floor's plain name from the Hub's floor number (`Room.floor`). The Hub has no floor NAME
/// (a flagged gap), so this is the conventional English reading of the number, nothing more.
String floorLabel(String? floorId) {
  final n = int.tryParse(floorId ?? '');
  if (n == null) return '';
  if (n < 0) return n == -1 ? 'Lower level' : 'Lower level ${-n}';
  if (n == 0) return 'Ground floor';
  const ord = ['', 'First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth'];
  return n < ord.length ? '${ord[n]} floor' : 'Floor $n';
}

/// Whether the sun is plausibly up at [hour] — the stand-in for the residence's own sun (see
/// DIVERGENCES: the residence location has no read path).
bool sunUpAt(int hour) => hour >= 6 && hour < 20;
