import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../roomsummary.dart';
import '../suntimes.dart';
import '../usage.dart';
import '../weather.dart';
import 'automations_screen.dart';
import 'backup_screen.dart';
import 'device_manager_screen.dart';
import 'discover_devices_screen.dart';
import 'driver_manager_screen.dart';
import 'energy_screen.dart';
import 'home_switcher.dart';
import 'room_view.dart';
import 'scenes_screen.dart';
import 'security_screen.dart';
import 'software_update_screen.dart';

/// Dashboard (§ Dashboard Improvements) — mobile parity with the web overview. The platform overview:
/// hub/device/extension health aggregated into calm stat tiles + quick actions, from the real signals
/// the backend exposes (diagnostics, registry, security, notifications). Metrics without a source
/// (CPU/memory/temperature) are omitted, not shown as placeholders.
String _greeting() {
  final h = DateTime.now().hour;
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  if (h < 21) return 'Good evening';
  return 'Good night';
}

// Operations signals (§ Operations Dashboard) — all from endpoints we already expose.
final _opsBackupProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).backupStatus());
final _opsUpdateProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).systemUpdate());
final _opsPendingProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).pendingDevices());
final _opsRunsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).automationRuns());

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final diag = ref.watch(diagnosticsProvider).valueOrNull;
    final registry = ref.watch(driverRegistryProvider).valueOrNull ?? const [];
    final security = ref.watch(securityProvider).valueOrNull;
    final autos = ref.watch(automationsProvider).valueOrNull ?? const [];
    final events = ref.watch(notificationsProvider).valueOrNull ?? const [];

    final counts = diag?['counts'] as Map<String, dynamic>?;
    final offline = ((diag?['offlineDevices'] as List?) ?? const []).length;
    final deviceTotal = (counts?['devices'] as int?) ?? 0;
    final online = deviceTotal - offline;
    final installed = registry.where((d) => d['installed'] == true).toList();
    final extErrors = installed.where((d) => d['status'] == 'error').length;
    final backendHealthy = (diag?['backend'] as Map<String, dynamic>?)?['healthy'] == true;
    final autoEnabled = autos.where((a) => a.enabled).length;
    final updatesAvailable = installed.where((d) => d['updateAvailable'] == true).length;

    // Operations signals.
    final backup = ref.watch(_opsBackupProvider).valueOrNull;
    final update = ref.watch(_opsUpdateProvider).valueOrNull;
    final pendingCount = (ref.watch(_opsPendingProvider).valueOrNull ?? const []).length;
    final autoErrors = (ref.watch(_opsRunsProvider).valueOrNull ?? const [])
        .where((r) => r['conditionsPassed'] == true && r['ok'] != true).length;
    final hubUpdate = update?['updateAvailable'] == true;

    // Composite health score (0–100) from real problem signals.
    int? score;
    if (diag != null) {
      var sc = 100;
      if (!backendHealthy) sc -= 30;
      sc -= (offline * 5).clamp(0, 20);
      sc -= (extErrors * 10).clamp(0, 20);
      sc -= (autoErrors * 5).clamp(0, 15);
      if (backup != null && (backup['schedule'] as Map?)?['enabled'] == true && backup['lastBackupAt'] == null) sc -= 15;
      if (security?['triggered'] == true) sc -= 20;
      score = sc < 0 ? 0 : sc;
    }
    // "My Home", not a system dashboard (§ Project Aurelia): operational telemetry is gated to
    // Developer/Installer mode; the homeowner sees a calm home screen.
    final devMode = ref.watch(devModeProvider).valueOrNull ?? false;
    final usage = ref.read(usageProvider.notifier);
    final allRooms = ref.watch(homeProvider).valueOrNull?.rooms ?? const <Room>[];
    final rooms = [...allRooms]..sort((a, b) => usage.count('room', b.id).compareTo(usage.count('room', a.id)));
    final allDevices = ref.watch(allDevicesProvider).valueOrNull ?? const <Device>[];
    final firstName = (((ref.watch(meProvider).valueOrNull?['user'] as Map<String, dynamic>?)?['displayName'] as String?) ?? '').trim().split(RegExp(r'\s+')).first;

    // A warm, true one-liner about the moment — real sunset time + which room is alive right now.
    Room? liveRoom;
    for (final r in rooms) {
      if (summarizeRoom(allDevices.where((d) => d.roomId == r.id).toList()).isNotEmpty) { liveRoom = r; break; }
    }
    final sunParts = <String>[];
    final loc = ref.read(locationProvider);
    final ss = sunset(loc.lat, loc.lon);
    if (ss != null) {
      final mins = ss.difference(DateTime.now()).inMinutes;
      if (mins > 0 && mins <= 90) {
        sunParts.add('Sunset in $mins minute${mins == 1 ? '' : 's'}');
      } else if (mins > 0 && mins < 600) {
        sunParts.add('Sunset at ${TimeOfDay.fromDateTime(ss).format(context)}');
      }
    }
    sunParts.add(liveRoom != null ? '${liveRoom.name} is alive' : 'Your home is resting');
    final emotionalLine = sunParts.join(' · ');

    // Plain-language things that actually need a decision — nothing when all is well.
    final attention = <({String textLabel, bool warn, Widget target})>[];
    if (security?['triggered'] == true) {
      attention.add((textLabel: 'Security alert — check your home', warn: true, target: Scaffold(appBar: AppBar(title: const Text('Security')), body: const SecurityScreen())));
    }
    if (offline > 0) attention.add((textLabel: '$offline device${offline == 1 ? '' : 's'} offline', warn: true, target: const DeviceManagerScreen()));
    if (autoErrors > 0) attention.add((textLabel: '$autoErrors automation${autoErrors == 1 ? '' : 's'} need attention', warn: true, target: const AutomationsScreen()));
    if (pendingCount > 0) attention.add((textLabel: '$pendingCount new device${pendingCount == 1 ? '' : 's'} waiting to be added', warn: false, target: const DeviceManagerScreen()));
    if (hubUpdate || updatesAvailable > 0) attention.add((textLabel: 'A software update is available', warn: false, target: const SoftwareUpdateScreen()));
    if (backup != null && (backup['schedule'] as Map?)?['enabled'] == true && backup['lastBackupAt'] == null) {
      attention.add((textLabel: 'No backup yet — protect your setup', warn: false, target: const BackupScreen()));
    }
    return SafeArea(
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(diagnosticsProvider);
          ref.invalidate(driverRegistryProvider);
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.xxl),
          children: [
            // The home greets you — typography is the hierarchy, no boxes (§ Project Monolith).
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Text('${_greeting()}${firstName.isNotEmpty ? ', $firstName' : ''}', style: const TextStyle(fontSize: 40, fontWeight: FontWeight.w600, letterSpacing: -1.2, height: 1.0))),
              const HomeSwitcherButton(),
            ]),
            const SizedBox(height: 10),
            Text(
              score == null
                  ? 'Settling in…'
                  : attention.isEmpty
                      ? emotionalLine
                      : attention.length == 1 ? 'One thing would like your attention.' : '${attention.length} things would like your attention.',
              style: text.titleMedium?.copyWith(color: scheme.onSurfaceVariant),
            ),
            const SizedBox(height: AureonSpacing.md),
            const Align(alignment: Alignment.centerLeft, child: WeatherChip()),
            const SizedBox(height: AureonSpacing.xl),

            // Needs attention — real problems only, in plain language. Absent when all is well.
            for (final a in attention) ...[
              InkWell(
                borderRadius: BorderRadius.circular(AureonRadius.lg),
                onTap: () => _push(context, a.target),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.md, vertical: 14),
                  decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.lg), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
                  child: Row(children: [
                    Container(width: 8, height: 8, decoration: BoxDecoration(shape: BoxShape.circle, color: a.warn ? AureonStatus.warning : AureonGold.c400)),
                    const SizedBox(width: 12),
                    Expanded(child: Text(a.textLabel, style: text.bodyMedium)),
                    Icon(Icons.chevron_right, color: scheme.onSurfaceVariant),
                  ]),
                ),
              ),
              const SizedBox(height: AureonSpacing.sm),
            ],
            if (attention.isNotEmpty) const SizedBox(height: AureonSpacing.sm),

            // Favourites — pinned scenes + devices, one tap away (§ Favorites).
            ..._favourites(context, ref),
            ..._recentlyUsed(context, ref),

            // Rooms are the hero — each a calm, softly-lit surface you step into (§ Project Monolith).
            if (rooms.isNotEmpty) ...[
              _sectionLabel(context, 'Rooms'),
              const SizedBox(height: AureonSpacing.sm),
              Builder(builder: (context) {
                final w = (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2;
                return Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
                  for (final r in rooms)
                    SizedBox(
                      width: w,
                      child: _RoomTile(
                        name: r.name,
                        chips: roomChips(allDevices.where((d) => d.roomId == r.id).toList()),
                        onTap: () { usage.record('room', r.id); _push(context, Scaffold(appBar: AppBar(title: Text(r.name)), body: RoomView(roomId: r.id, roomName: r.name, areaType: r.areaType, heroImageUrl: r.heroImageUrl))); },
                      ),
                    ),
                ]);
              }),
              const SizedBox(height: AureonSpacing.lg),
            ],

            // Everyday jumps — understated, the rooms stay the hero.
            _sectionLabel(context, 'Shortcuts'),
            const SizedBox(height: AureonSpacing.sm),
            Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
              _Quick(icon: Icons.auto_awesome_outlined, label: 'Scenes', onTap: () => _push(context, const ScenesScreen())),
              _Quick(icon: Icons.travel_explore_outlined, label: 'Add a device', onTap: () => _push(context, const DiscoverDevicesScreen())),
              _Quick(icon: Icons.bolt_outlined, label: 'Energy', onTap: () => _push(context, const EnergyScreen())),
              _Quick(icon: Icons.extension_outlined, label: 'Extensions', onTap: () => _push(context, const ExtensionCenterScreen())),
            ]),

            if (events.isNotEmpty) ...[
              const SizedBox(height: AureonSpacing.lg),
              _sectionLabel(context, 'Recent activity'),
              const SizedBox(height: AureonSpacing.sm),
              for (final e in events.take(5))
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(children: [
                    Expanded(child: Text(e.title, style: text.bodyMedium)),
                    Text(_time(e.createdAt), style: text.labelSmall),
                  ]),
                ),
            ],

            // ── Operations — Developer/Installer only. A homeowner never sees system telemetry. ──
            if (devMode) ...[
              const SizedBox(height: AureonSpacing.lg),
              Builder(builder: (context) {
                final half = (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2;
                Widget s(Widget w) => SizedBox(width: half, child: w);
                return Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
                  s(_Stat(value: '$online', label: 'Online devices', sub: 'of $deviceTotal', color: AureonStatus.good, onTap: () => _push(context, const DeviceManagerScreen()))),
                  s(_Stat(value: '$offline', label: 'Offline', sub: offline == 0 ? 'none' : 'need attention', color: offline > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const DeviceManagerScreen()))),
                  s(_Stat(value: '${installed.length}', label: 'Extensions', sub: extErrors > 0 ? '$extErrors error' : 'all healthy', color: extErrors > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const ExtensionCenterScreen()))),
                  s(_Stat(value: '$autoEnabled/${autos.length}', label: 'Automations', sub: 'enabled', onTap: () => _push(context, const AutomationsScreen()))),
                  s(_Stat(value: backup == null ? '—' : '${backup['backupCount']}', label: 'Backups', sub: backup?['lastBackupAt'] == null ? 'none yet' : 'kept', color: (backup != null && (backup['schedule'] as Map?)?['enabled'] == true && backup['lastBackupAt'] == null) ? AureonStatus.warning : null, onTap: () => _push(context, const BackupScreen()))),
                  s(_Stat(value: hubUpdate ? '1' : (updatesAvailable > 0 ? '$updatesAvailable' : '0'), label: 'Updates', sub: hubUpdate ? 'hub v${(update?['latest'] as Map?)?['version']}' : updatesAvailable > 0 ? 'extensions' : 'up to date', color: (hubUpdate || updatesAvailable > 0) ? AureonStatus.warning : null, onTap: () => _push(context, const SoftwareUpdateScreen()))),
                ]);
              }),
              const SizedBox(height: AureonSpacing.lg),
              ..._hubResources(context, ref),
              if (diag != null)
                Text('Hub ${diag['hubVersion']} · backend ${(diag['backend'] as Map)['kind']} · ${backendHealthy ? 'healthy' : 'degraded'}',
                    style: text.labelSmall?.copyWith(color: backendHealthy ? AureonStatus.good : AureonStatus.critical)),
            ],
          ],
        ),
      ),
    );
  }

  /// Pinned scenes + devices — one tap away (§ Favorites). Empty when nothing is pinned.
  List<Widget> _favourites(BuildContext context, WidgetRef ref) {
    final favs = ref.watch(favoritesProvider).valueOrNull ?? const [];
    if (favs.isEmpty) return const [];
    final sceneIds = {for (final f in favs) if (f.type == 'scene') f.refId};
    final deviceIds = {for (final f in favs) if (f.type == 'device') f.refId};
    final scenes = (ref.watch(scenesProvider).valueOrNull ?? const []).where((s) => sceneIds.contains(s.id)).toList();
    final devices = (ref.watch(allDevicesProvider).valueOrNull ?? const []).where((d) => deviceIds.contains(d.id)).toList();
    if (scenes.isEmpty && devices.isEmpty) return const [];
    final text = Theme.of(context).textTheme;
    return [
      Text('Favourites', style: text.titleSmall),
      const SizedBox(height: AureonSpacing.sm),
      Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
        for (final s in scenes)
          _FavTile(icon: Icons.auto_awesome_outlined, label: s.name, sub: 'Scene', onTap: () { ref.read(usageProvider.notifier).record('scene', s.id); ref.read(clientProvider).activateScene(s.id); }),
        for (final d in devices)
          _FavTile(icon: d.isOn ? Icons.circle : Icons.circle_outlined, label: d.name, sub: d.isOn ? 'On' : 'Off', accent: d.isOn, onTap: () async {
            ref.read(usageProvider.notifier).record('device', d.id);
            await ref.read(clientProvider).command(d.id, {'capability': 'onoff', 'action': 'toggle'});
            ref.invalidate(allDevicesProvider);
          }),
      ]),
      const SizedBox(height: AureonSpacing.lg),
    ];
  }

  /// Recently used (§ Personalization) — the scenes & devices the homeowner touched most recently,
  /// surfaced automatically so everyday things stay one tap away. Appears ONLY when there's history.
  List<Widget> _recentlyUsed(BuildContext context, WidgetRef ref) {
    final recent = ref.watch(usageProvider.notifier).recent();
    if (recent.isEmpty) return const [];
    final scenes = ref.watch(scenesProvider).valueOrNull ?? const [];
    final devices = ref.watch(allDevicesProvider).valueOrNull ?? const [];
    final tiles = <Widget>[];
    for (final u in recent) {
      if (u.kind == 'scene') {
        final s = scenes.where((x) => x.id == u.id).firstOrNull;
        if (s == null) continue;
        tiles.add(_FavTile(icon: Icons.auto_awesome_outlined, label: s.name, sub: 'Scene',
            onTap: () { ref.read(usageProvider.notifier).record('scene', s.id); ref.read(clientProvider).activateScene(s.id); }));
      } else {
        final d = devices.where((x) => x.id == u.id).firstOrNull;
        if (d == null) continue;
        tiles.add(_FavTile(icon: d.isOn ? Icons.circle : Icons.circle_outlined, label: d.name, sub: d.isOn ? 'On' : 'Off', accent: d.isOn,
            onTap: () async {
              ref.read(usageProvider.notifier).record('device', d.id);
              await ref.read(clientProvider).command(d.id, {'capability': 'onoff', 'action': 'toggle'});
              ref.invalidate(allDevicesProvider);
            }));
      }
    }
    if (tiles.isEmpty) return const [];
    return [
      Text('Recently used', style: Theme.of(context).textTheme.titleSmall),
      const SizedBox(height: AureonSpacing.sm),
      Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: tiles),
      const SizedBox(height: AureonSpacing.lg),
    ];
  }

  /// Real host telemetry tiles — CPU / memory / storage / temperature / uptime. Rendered only when
  /// the platform actually measures a field (§ Installer Dashboard, no fabrication).
  List<Widget> _hubResources(BuildContext context, WidgetRef ref) {
    final sys = ref.watch(systemHealthProvider).valueOrNull;
    if (sys == null) return const [];
    final cpu = sys['cpu'] as Map<String, dynamic>?;
    final mem = sys['memory'] as Map<String, dynamic>?;
    final storage = sys['storage'] as Map<String, dynamic>?;
    final temp = (sys['temperatureC'] as num?)?.toDouble();
    final uptime = (sys['uptimeSeconds'] as num?)?.toInt();
    final text = Theme.of(context).textTheme;
    final tiles = <Widget>[];
    if (cpu?['utilizationPct'] != null) {
      tiles.add(_Meter(label: 'CPU', pct: (cpu!['utilizationPct'] as num).toDouble(), sub: '${cpu['cores']} cores · load ${cpu['loadAvg1']}'));
    }
    if (mem != null) {
      tiles.add(_Meter(label: 'Memory', pct: (mem['usedPct'] as num).toDouble(), sub: '${_bytes((mem['usedBytes'] as num).toInt())} / ${_bytes((mem['totalBytes'] as num).toInt())}'));
    }
    if (storage != null) {
      tiles.add(_Meter(label: 'Storage', pct: (storage['usedPct'] as num).toDouble(), sub: '${_bytes((storage['usedBytes'] as num).toInt())} / ${_bytes((storage['totalBytes'] as num).toInt())}'));
    }
    if (temp != null) tiles.add(_Stat(value: '$temp°', label: 'Temperature', sub: 'CPU', color: temp >= 80 ? AureonStatus.warning : null));
    if (uptime != null) tiles.add(_Stat(value: _uptime(uptime), label: 'Uptime', sub: 'hub process'));
    if (tiles.isEmpty) return const [];
    return [
      Text('Hub resources', style: text.titleSmall),
      const SizedBox(height: AureonSpacing.sm),
      Builder(builder: (context) {
        final half = (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2;
        return Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
          for (final t in tiles) SizedBox(width: half, child: t),
        ]);
      }),
      const SizedBox(height: AureonSpacing.lg),
    ];
  }

  static String _bytes(int n) {
    if (n >= 1 << 30) return '${(n / (1 << 30)).toStringAsFixed(1)} GB';
    if (n >= 1 << 20) return '${(n / (1 << 20)).round()} MB';
    return '${(n / 1024).round()} KB';
  }

  static String _uptime(int s) {
    final d = s ~/ 86400, h = (s % 86400) ~/ 3600, m = (s % 3600) ~/ 60;
    return d > 0 ? '${d}d ${h}h' : h > 0 ? '${h}h ${m}m' : '${m}m';
  }

  static void _push(BuildContext c, Widget s) => Navigator.of(c).push(MaterialPageRoute<void>(builder: (_) => s));
  static String _time(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    return d == null ? '' : '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }
}

/// A quiet uppercase section label — typography as hierarchy, no boxes (§ Project Monolith).
Widget _sectionLabel(BuildContext context, String label) => Text(
      label.toUpperCase(),
      style: Theme.of(context).textTheme.labelMedium?.copyWith(
            letterSpacing: 1.1,
            fontWeight: FontWeight.w600,
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
    );

/// A deterministic warm tint per room so each reads as its own softly-lit place (no photo required).
LinearGradient _roomTint(String name) {
  var h = 0;
  for (var i = 0; i < name.length; i++) {
    h = (h * 31 + name.codeUnitAt(i)) % 360;
  }
  return LinearGradient(
    begin: Alignment.topLeft,
    end: Alignment.bottomRight,
    colors: [
      HSLColor.fromAHSL(1, h.toDouble(), 0.20, 0.15).toColor(),
      HSLColor.fromAHSL(1, ((h + 28) % 360).toDouble(), 0.18, 0.09).toColor(),
    ],
  );
}

/// Rooms are the hero: a softly-lit tile with an ambient shadow and a bottom-anchored name.
IconData _chipIcon(String kind) {
  switch (kind) {
    case 'light': return Icons.lightbulb_outline;
    case 'climate': return Icons.thermostat;
    case 'media': return Icons.music_note_outlined;
    case 'fan': return Icons.mode_fan_off_outlined;
    case 'switch': return Icons.power_settings_new;
    case 'cover': return Icons.blinds_outlined;
    default: return Icons.circle_outlined;
  }
}

class _RoomTile extends StatelessWidget {
  const _RoomTile({required this.name, required this.onTap, this.chips = const []});
  final String name;
  final List<RoomChip> chips;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      borderRadius: BorderRadius.circular(22),
      onTap: onTap,
      child: Container(
        height: 132,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          gradient: _roomTint(name),
          borderRadius: BorderRadius.circular(22),
          border: Border.all(color: Colors.white.withValues(alpha: 0.06)),
          boxShadow: [BoxShadow(color: Colors.black.withValues(alpha: 0.28), blurRadius: 24, offset: const Offset(0, 10))],
        ),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.end,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(name, style: text.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (chips.isEmpty)
              Row(children: [
                Container(width: 6, height: 6, decoration: BoxDecoration(shape: BoxShape.circle, color: Colors.white.withValues(alpha: 0.45))),
                const SizedBox(width: 7),
                Text('Resting', style: text.labelMedium?.copyWith(color: Colors.white.withValues(alpha: 0.6))),
              ])
            else
              Wrap(spacing: 12, runSpacing: 6, children: [
                for (final c in chips)
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Icon(_chipIcon(c.kind), size: 15, color: Colors.white.withValues(alpha: 0.85)),
                    const SizedBox(width: 4),
                    Text(c.label, style: text.labelLarge?.copyWith(color: Colors.white.withValues(alpha: 0.9), fontWeight: FontWeight.w600)),
                  ]),
              ]),
          ],
        ),
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label, this.sub, this.color, this.onTap});
  final String value;
  final String label;
  final String? sub;
  final Color? color;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AureonRadius.md),
      child: Container(
        padding: const EdgeInsets.all(AureonSpacing.md),
        decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.md), border: Border.all(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.4))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
          Text(value, style: text.headlineSmall?.copyWith(color: color, fontWeight: FontWeight.w600)),
          Text(label, style: text.labelMedium),
          if (sub != null) Text(sub!, style: text.labelSmall),
        ]),
      ),
    );
  }
}

/// A resource tile with a usage bar (0..100). Turns amber past 80%.
class _Meter extends StatelessWidget {
  const _Meter({required this.label, required this.pct, this.sub});
  final String label;
  final double pct;
  final String? sub;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final warn = pct >= 80;
    return Container(
      padding: const EdgeInsets.all(AureonSpacing.md),
      decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.md), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
        Text('${pct.round()}%', style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w600, color: warn ? AureonStatus.warning : null)),
        Text(label, style: text.labelMedium),
        const SizedBox(height: 4),
        ClipRRect(
          borderRadius: BorderRadius.circular(999),
          child: LinearProgressIndicator(
            value: (pct.clamp(0, 100)) / 100,
            minHeight: 5,
            backgroundColor: scheme.outlineVariant.withValues(alpha: 0.4),
            valueColor: AlwaysStoppedAnimation(warn ? AureonStatus.warning : AureonStatus.good),
          ),
        ),
        if (sub != null) Padding(padding: const EdgeInsets.only(top: 2), child: Text(sub!, style: text.labelSmall)),
      ]),
    );
  }
}

/// A favourite tile — a scene to fire or a device to toggle.
class _FavTile extends StatelessWidget {
  const _FavTile({required this.icon, required this.label, required this.sub, required this.onTap, this.accent = false});
  final IconData icon;
  final String label;
  final String sub;
  final VoidCallback onTap;
  final bool accent;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return SizedBox(
      width: (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AureonRadius.md),
        child: Container(
          padding: const EdgeInsets.all(AureonSpacing.md),
          decoration: BoxDecoration(
            color: AureonBase.surface,
            borderRadius: BorderRadius.circular(AureonRadius.md),
            border: Border.all(color: (accent ? AureonGold.c400 : scheme.outlineVariant).withValues(alpha: accent ? 0.5 : 0.4)),
          ),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Icon(icon, size: 20, color: accent ? AureonGold.c400 : scheme.primary),
            const SizedBox(height: 4),
            Text(label, style: text.labelLarge, maxLines: 1, overflow: TextOverflow.ellipsis),
            Text(sub, style: text.labelSmall),
          ]),
        ),
      ),
    );
  }
}

class _Quick extends StatelessWidget {
  const _Quick({required this.icon, required this.label, required this.onTap});
  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    // Understated text link, not a card — the rooms stay the hero (§ subtract cards).
    return SizedBox(
      width: (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(AureonRadius.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 12),
          child: Row(children: [
            Icon(icon, size: 20, color: AureonGold.c400),
            const SizedBox(width: 11),
            Expanded(child: Text(label, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 15, color: scheme.onSurfaceVariant))),
          ]),
        ),
      ),
    );
  }
}
