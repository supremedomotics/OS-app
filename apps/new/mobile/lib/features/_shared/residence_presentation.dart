import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// Floors in order, each with its spaces in the Hub's order. Spaces with no floor come last,
/// under no heading.
List<({String? floorId, List<Space> spaces})> floorsOf(List<Space> spaces) {
  final by = <String?, List<Space>>{};
  for (final s in spaces) {
    by.putIfAbsent(s.floorId, () => []).add(s);
  }
  final ids = by.keys.toList()
    ..sort((a, b) {
      if (a == null) return 1;
      if (b == null) return -1;
      return (int.tryParse(a) ?? 0).compareTo(int.tryParse(b) ?? 0);
    });
  return [for (final id in ids) (floorId: id, spaces: by[id]!)];
}

/// A hero picture for a space. A Hub-relative path (`/v1/rooms/:id/hero-image?v=<hash>`) is fetched
/// with the paired Mobile's authorization and cached by that versioned URL; until it arrives — or
/// when the Hub cannot supply it — there is no picture and the space is its honest tonal plate. An
/// absolute http(s) URL is shown as given.
ImageProvider? heroImageFor(WidgetRef ref, Space space) {
  final u = space.imageUrl;
  if (u == null) return null;
  if (HeroImageStore.isHubPath(u)) {
    final bytes = ref.watch(heroBytesProvider(u)).valueOrNull;
    return bytes == null ? null : MemoryImage(bytes);
  }
  final uri = Uri.tryParse(u);
  return uri != null && uri.hasScheme && uri.scheme.startsWith('http')
      ? NetworkImage(u)
      : null;
}

/// A space's plate: words from confirmed state, light from confirmed state.
Widget plateFor(
  BuildContext context,
  WidgetRef ref,
  Space space,
  ResidenceSnapshot snap,
  List<CommandRecord> inFlight,
  int hour,
  VoidCallback onTap,
) {
  final c = spaceCondition(snap, space.id,
      commands: inFlight, sunUp: sunUpAt(hour));
  final look = lookFor(lightOf(snap.devicesIn(space.id)));
  final said = [c.line, c.attention].where((e) => e != null && e.isNotEmpty);
  return SpacePlate(
    key: ValueKey('space-${space.id}'),
    name: space.name,
    kicker: c.experience?.name,
    line: c.line,
    flag: c.attention ?? (c.adjusting ? 'Adjusting…' : null),
    flagQuiet: c.attention == null,
    look: look,
    image: heroImageFor(ref, space),
    semanticLabel:
        '${space.name}${c.experience != null ? ', ${c.experience!.name}' : ''}${said.isEmpty ? '' : '. ${said.join('. ')}'}',
    onTap: onTap,
  );
}
