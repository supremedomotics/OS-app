/// The systems Control offers for a scope — only those the scope's devices actually have (Golden
/// Master `control.js` SYSTEMS, capability-resolved). A scope with no shades has no Shades row;
/// nothing is listed "for completeness".
///
/// Protection (security/surveillance) and Physical objects (the device inventory) are not offered
/// yet: production has no arming/contact contract and the device sheet is not built (both flagged
/// in the implementation map), so they are absent rather than drawn inert.
library;

import 'residence_description.dart';
import 'residence_state.dart';
import 'room_controls.dart';
import 'command_tracker.dart';

enum ControlSystemId { lighting, climate, shades, media }

class ControlSystem {
  final ControlSystemId id;
  final String group; // Environment · Media
  final String name;

  /// The glyph concept (see SupremeGlyph): light · atmosphere · aperture · resonance.
  final String glyph;
  final String summary;
  const ControlSystem(this.id, this.group, this.name, this.glyph, this.summary);
}

List<ControlSystem> controlSystems(
    Iterable<DeviceRecord> devices, Iterable<CommandRecord> inFlight) {
  final ds = devices.toList();
  final out = <ControlSystem>[];

  final lights = RoomLights.of(ds, inFlight);
  if (lights != null) {
    final on = lights.online;
    out.add(ControlSystem(
        ControlSystemId.lighting,
        'Environment',
        'Lighting',
        'light',
        on.isEmpty
            ? 'Not responding'
            : lights.onCount == 0
                ? 'All off'
                : '${lights.onCount} of ${lights.lights.length} on${lights.level != null ? ' · ${lights.level}%' : ''}'));
  }

  final zones = RoomClimate.allOf(ds, inFlight);
  if (zones.isNotEmpty) {
    final live = zones.where((z) => z.online && z.ambientC != null).toList();
    String s;
    if (live.isEmpty) {
      s = 'Not responding';
    } else if (live.length == 1) {
      final z = live.first;
      s = !z.on
          ? 'Off · ${fmtTemp(z.ambientC!)}'
          : '${fmtTemp(z.ambientC!)} · set to ${fmtTemp(z.targetC ?? z.ambientC!)}';
    } else {
      final t = live.map((z) => z.ambientC!).toList()..sort();
      s = '${live.length} zones · ${fmtTemp(t.first)} – ${fmtTemp(t.last)}';
    }
    out.add(ControlSystem(
        ControlSystemId.climate, 'Environment', 'Climate', 'atmosphere', s));
  }

  final shades = RoomShades.of(ds, inFlight);
  if (shades != null) {
    final p = shades.position;
    out.add(ControlSystem(
        ControlSystemId.shades,
        'Environment',
        'Shades',
        'aperture',
        shades.online.isEmpty || p == null
            ? 'Not responding'
            : '${p >= 95 ? 'Open' : p <= 5 ? 'Closed' : '$p% open'}${shades.online.length < shades.shades.length ? ' · ${shades.shades.length - shades.online.length} not responding' : ''}'));
  }

  final music = RoomMusic.allOf(ds, inFlight);
  if (music.isNotEmpty) {
    final playing = music.where((m) => m.online && m.playing).toList();
    final s = playing.length == 1 && playing.first.title != null
        ? '${playing.first.title}${playing.first.artist != null ? ' · ${playing.first.artist}' : ''}'
        : playing.isNotEmpty
            ? 'Music in ${playing.length} ${playing.length == 1 ? 'space' : 'spaces'}'
            : music.any((m) => m.online)
                ? 'Quiet'
                : 'Not responding';
    out.add(ControlSystem(ControlSystemId.media, 'Media', 'Media', 'resonance', s));
  }
  return out;
}
