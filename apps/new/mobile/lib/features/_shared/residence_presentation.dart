import 'package:flutter/widgets.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

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

/// A hero picture for a space, only when the Hub gave an absolute URL. A hub-relative path
/// (`/v1/rooms/:id/hero-image`) needs an authenticated fetch that does not exist yet (flagged in
/// the implementation map), so it renders as the honest tonal plate instead of a broken image.
ImageProvider? heroImageFor(Space space) {
  final u = space.imageUrl;
  if (u == null) return null;
  final uri = Uri.tryParse(u);
  return uri != null && uri.hasScheme && uri.scheme.startsWith('http')
      ? NetworkImage(u)
      : null;
}

/// A space's plate: words from confirmed state, light from confirmed state.
Widget plateFor(
  BuildContext context,
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
    image: heroImageFor(space),
    semanticLabel:
        '${space.name}${c.experience != null ? ', ${c.experience!.name}' : ''}${said.isEmpty ? '' : '. ${said.join('. ')}'}',
    onTap: onTap,
  );
}
