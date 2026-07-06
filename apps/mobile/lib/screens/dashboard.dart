import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import '../weather.dart';
import 'automations_screen.dart';
import 'backup_screen.dart';
import 'device_manager_screen.dart';
import 'discover_devices_screen.dart';
import 'driver_manager_screen.dart';
import 'energy_screen.dart';
import 'home_switcher.dart';
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
    final healthy = score != null && score >= 90;

    return SafeArea(
      child: RefreshIndicator(
        onRefresh: () async {
          ref.invalidate(diagnosticsProvider);
          ref.invalidate(driverRegistryProvider);
        },
        child: ListView(
          padding: const EdgeInsets.fromLTRB(AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.lg, AureonSpacing.xxl),
          children: [
            Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(_greeting(), style: text.titleLarge),
                Text('Supreme OS${diag != null ? ' · v${diag['hubVersion']}' : ''}', style: text.labelMedium),
              ])),
              const HomeSwitcherButton(),
            ]),
            const SizedBox(height: AureonSpacing.md),
            const Align(alignment: Alignment.centerLeft, child: WeatherChip()),
            const SizedBox(height: AureonSpacing.md),

            // Health hero.
            Container(
              padding: const EdgeInsets.all(AureonSpacing.md),
              decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.lg), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
              child: Row(children: [
                Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: diag == null ? scheme.onSurfaceVariant : healthy ? AureonStatus.good : AureonStatus.warning)),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(score == null ? 'Checking…' : 'Health score $score/100 · ${score >= 90 ? 'All systems healthy' : score >= 70 ? 'Minor issues' : 'Attention needed'}', style: text.titleMedium),
                  Text(diag == null ? '' : '$online/$deviceTotal devices online · ${installed.length} extensions${extErrors > 0 ? ' · $extErrors error' : ''}${autoErrors > 0 ? ' · $autoErrors automation error' : ''}', style: text.labelSmall),
                ])),
                if (score != null) Text('$score', style: text.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
              ]),
            ),
            const SizedBox(height: AureonSpacing.md),

            // Stat tiles — intrinsic-height (a Wrap, not a fixed-aspect grid) so content never clips.
            Builder(builder: (context) {
              final half = (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2;
              Widget s(Widget w) => SizedBox(width: half, child: w);
              return Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
                s(_Stat(value: '$online', label: 'Online devices', sub: 'of $deviceTotal', color: AureonStatus.good, onTap: () => _push(context, const DeviceManagerScreen()))),
                s(_Stat(value: '$offline', label: 'Offline', sub: offline == 0 ? 'none' : 'need attention', color: offline > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const DeviceManagerScreen()))),
                s(_Stat(value: '${installed.length}', label: 'Extensions', sub: extErrors > 0 ? '$extErrors error' : 'all healthy', color: extErrors > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const ExtensionCenterScreen()))),
                s(_Stat(value: '$autoEnabled/${autos.length}', label: 'Automations', sub: 'enabled', onTap: () => _push(context, const AutomationsScreen()))),
                s(_Stat(value: (security?['triggered'] == true) ? 'Alert' : _cap((security?['armMode'] as String?) ?? '—'), label: 'Security', sub: 'armed state', color: security?['triggered'] == true ? AureonStatus.critical : null)),
                s(_Stat(value: counts == null ? '—' : '${counts['rooms']} · ${counts['scenes']}', label: 'Rooms · Scenes', sub: 'in this home')),
              ]);
            }),
            const SizedBox(height: AureonSpacing.sm),

            // Operations tiles — backups / updates / pending / automation errors.
            Builder(builder: (context) {
              final half = (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2;
              Widget s(Widget w) => SizedBox(width: half, child: w);
              return Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
                s(_Stat(value: backup == null ? '—' : '${backup['backupCount']}', label: 'Backups', sub: backup?['lastBackupAt'] == null ? 'none yet' : 'kept', color: (backup != null && (backup['schedule'] as Map?)?['enabled'] == true && backup['lastBackupAt'] == null) ? AureonStatus.warning : null, onTap: () => _push(context, const BackupScreen()))),
                s(_Stat(value: hubUpdate ? '1' : (updatesAvailable > 0 ? '$updatesAvailable' : '0'), label: 'Updates', sub: hubUpdate ? 'hub v${(update?['latest'] as Map?)?['version']}' : updatesAvailable > 0 ? 'extensions' : 'up to date', color: (hubUpdate || updatesAvailable > 0) ? AureonStatus.warning : null, onTap: () => _push(context, const SoftwareUpdateScreen()))),
                s(_Stat(value: '$pendingCount', label: 'Pending approval', sub: pendingCount > 0 ? 'review devices' : 'none', color: pendingCount > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const DeviceManagerScreen()))),
                s(_Stat(value: '$autoErrors', label: 'Automation errors', sub: autoErrors > 0 ? 'check activity' : 'none', color: autoErrors > 0 ? AureonStatus.warning : null, onTap: () => _push(context, const AutomationsScreen()))),
              ]);
            }),
            const SizedBox(height: AureonSpacing.lg),

            // Favourites — pinned scenes + devices, one tap away (§ Favorites).
            ..._favourites(context, ref),

            // Hub resources — real host telemetry (§ Installer Dashboard). Only measured fields show.
            ..._hubResources(context, ref),

            // Quick actions.
            Text('Quick actions', style: text.titleSmall),
            const SizedBox(height: AureonSpacing.sm),
            Wrap(spacing: AureonSpacing.sm, runSpacing: AureonSpacing.sm, children: [
              _Quick(icon: Icons.travel_explore_outlined, label: 'Discover Devices', onTap: () => _push(context, const DiscoverDevicesScreen())),
              _Quick(icon: Icons.extension_outlined, label: 'Extension Center', onTap: () => _push(context, const ExtensionCenterScreen())),
              _Quick(icon: Icons.bolt_outlined, label: 'Energy', onTap: () => _push(context, const EnergyScreen())),
              _Quick(icon: Icons.account_tree_outlined, label: 'Automations', onTap: () => _push(context, const AutomationsScreen())),
            ]),

            if (events.isNotEmpty) ...[
              const SizedBox(height: AureonSpacing.lg),
              Text('Recent events', style: text.titleSmall),
              const SizedBox(height: AureonSpacing.sm),
              for (final e in events.take(6))
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Row(children: [
                    Expanded(child: Text(e.title, style: text.bodyMedium)),
                    Text(_time(e.createdAt), style: text.labelSmall),
                  ]),
                ),
            ],

            if (diag != null) ...[
              const SizedBox(height: AureonSpacing.lg),
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
          _FavTile(icon: Icons.auto_awesome_outlined, label: s.name, sub: 'Scene', onTap: () => ref.read(clientProvider).activateScene(s.id)),
        for (final d in devices)
          _FavTile(icon: d.isOn ? Icons.circle : Icons.circle_outlined, label: d.name, sub: d.isOn ? 'On' : 'Off', accent: d.isOn, onTap: () async {
            await ref.read(clientProvider).command(d.id, {'capability': 'onoff', 'action': 'toggle'});
            ref.invalidate(allDevicesProvider);
          }),
      ]),
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
  static String _cap(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
  static String _time(String iso) {
    final d = DateTime.tryParse(iso)?.toLocal();
    return d == null ? '' : '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
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
    return SizedBox(
      width: (MediaQuery.sizeOf(context).width - AureonSpacing.lg * 2 - AureonSpacing.sm) / 2,
      child: OutlinedButton.icon(
        onPressed: onTap,
        icon: Icon(icon, size: 18, color: scheme.primary),
        label: Align(alignment: Alignment.centerLeft, child: Text(label, overflow: TextOverflow.ellipsis)),
        style: OutlinedButton.styleFrom(padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14), alignment: Alignment.centerLeft),
      ),
    );
  }
}
