import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'automations_screen.dart';
import 'device_manager_screen.dart';
import 'room_categories_screen.dart';
import 'scenes_screen.dart';

/// Global search (§ Global Search) — mobile parity. Fuzzy-jump to any device, room, scene or
/// automation. Pure client-side over data the app already has; tapping a result opens it.
class _Result {
  _Result(this.label, this.sub, this.open);
  final String label;
  final String sub;
  final Widget Function() open;
}

/// A light subsequence score (all query chars appear in order); null = no match, lower = better.
double? _score(String query, String text) {
  if (query.isEmpty) return 0;
  final q = query.toLowerCase();
  final t = text.toLowerCase();
  var qi = 0, first = -1, last = -1;
  for (var ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] == q[qi]) {
      if (first < 0) first = ti;
      last = ti;
      qi++;
    }
  }
  if (qi < q.length) return null;
  return first + (last - first) * 0.5;
}

class GlobalSearchScreen extends ConsumerStatefulWidget {
  const GlobalSearchScreen({super.key});
  @override
  ConsumerState<GlobalSearchScreen> createState() => _GlobalSearchScreenState();
}

class _GlobalSearchScreenState extends ConsumerState<GlobalSearchScreen> {
  String _q = '';

  @override
  Widget build(BuildContext context) {
    final home = ref.watch(homeProvider).valueOrNull;
    final devices = ref.watch(allDevicesProvider).valueOrNull ?? const [];
    final scenes = ref.watch(scenesProvider).valueOrNull ?? const [];
    final autos = ref.watch(automationsProvider).valueOrNull ?? const [];
    final rooms = home?.rooms ?? const [];
    final roomName = {for (final r in rooms) r.id: r.name};

    final all = <_Result>[
      for (final r in rooms)
        _Result(r.name, 'Room', () => Scaffold(appBar: AppBar(title: Text(r.name)), body: RoomCategoriesScreen(roomId: r.id, roomName: r.name, areaType: r.areaType, heroImageUrl: r.heroImageUrl))),
      for (final d in devices)
        _Result(d.name, 'Device · ${roomName[d.roomId] ?? 'Unassigned'}', () => const DeviceManagerScreen()),
      for (final s in scenes) _Result(s.name, 'Scene', () => const ScenesScreen()),
      for (final a in autos) _Result(a.name, 'Automation', () => const AutomationsScreen()),
    ];

    final results = (all.map((r) => (r, _score(_q, '${r.label} ${r.sub}'))).where((x) => x.$2 != null).toList()
      ..sort((a, b) => a.$2!.compareTo(b.$2!)))
        .map((x) => x.$1)
        .take(40)
        .toList();

    return Scaffold(
      appBar: AppBar(
        title: TextField(
          autofocus: true,
          decoration: const InputDecoration(border: InputBorder.none, hintText: 'Search devices, rooms, scenes…'),
          onChanged: (v) => setState(() => _q = v),
        ),
      ),
      body: ListView(
        children: [
          if (results.isEmpty && _q.isNotEmpty)
            const Padding(padding: EdgeInsets.all(20), child: Text('No matches')),
          for (final r in results)
            ListTile(
              title: Text(r.label),
              trailing: Text(r.sub, style: Theme.of(context).textTheme.labelSmall),
              onTap: () {
                Navigator.of(context).pushReplacement(MaterialPageRoute<void>(builder: (_) => r.open()));
              },
            ),
        ],
      ),
    );
  }
}
