import 'package:supreme_sdk/supreme_sdk.dart';

/// A live, human summary of what's happening in a room — "3 lights · 1 fan · blinds 100%".
/// Mirrors the web helper: counts every device that is ON by friendly category, and lists open
/// covers with their position. Homeowner language only. Empty string when the room is at rest.
String summarizeRoom(List<Device> devices) {
  var lights = 0, climate = 0, media = 0, fans = 0, switches = 0;
  final coversOpen = <int>[];

  for (final d in devices) {
    final caps = d.capabilities;
    final st = d.state;
    Map<String, dynamic>? s(String k) => st[k] as Map<String, dynamic>?;

    if (caps.contains('position')) {
      final p = ((s('position')?['position'] as num?) ?? 0).round();
      if (p > 0) coversOpen.add(p);
      continue;
    }
    if (caps.contains('brightness') || caps.contains('color')) {
      if ((s('brightness')?['on'] ?? s('color')?['on'] ?? s('onoff')?['on']) == true) lights++;
      continue;
    }
    if (caps.contains('temperature')) {
      final m = s('temperature')?['mode'];
      if (m != null && m != 'off') climate++;
      continue;
    }
    if (caps.contains('media')) {
      final pb = s('media')?['playback'];
      if (pb == 'playing' || pb == 'paused') media++;
      continue;
    }
    if (caps.contains('fan')) {
      if (s('fan')?['on'] == true) fans++;
      continue;
    }
    if (caps.contains('onoff')) {
      if (s('onoff')?['on'] == true) switches++;
      continue;
    }
  }

  String plural(int n, String word) {
    final p = word == 'switch' ? 'switches' : '${word}s';
    return '$n ${n == 1 ? word : p}';
  }

  final parts = <String>[];
  if (lights > 0) parts.add(plural(lights, 'light'));
  if (climate > 0) parts.add('$climate climate');
  if (media > 0) parts.add(plural(media, 'player'));
  if (fans > 0) parts.add(plural(fans, 'fan'));
  if (switches > 0) parts.add(plural(switches, 'switch'));
  if (coversOpen.length == 1) {
    parts.add('blinds ${coversOpen.first}%');
  } else if (coversOpen.length > 1) {
    parts.add('${coversOpen.length} blinds open');
  }
  return parts.join(' · ');
}
