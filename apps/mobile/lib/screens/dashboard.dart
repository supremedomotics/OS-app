import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import 'automations_screen.dart';
import 'device_manager_screen.dart';
import 'discover_devices_screen.dart';
import 'driver_manager_screen.dart';
import 'energy_screen.dart';
import 'home_switcher.dart';

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
    final healthy = diag != null && backendHealthy && offline == 0 && extErrors == 0;

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
            const SizedBox(height: AureonSpacing.lg),

            // Health hero.
            Container(
              padding: const EdgeInsets.all(AureonSpacing.md),
              decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.lg), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
              child: Row(children: [
                Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: diag == null ? scheme.onSurfaceVariant : healthy ? AureonStatus.good : AureonStatus.warning)),
                const SizedBox(width: 14),
                Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(diag == null ? 'Checking…' : healthy ? 'All systems healthy' : 'Attention needed', style: text.titleMedium),
                  Text(diag == null ? '' : '$online/$deviceTotal devices online · ${installed.length} extensions${extErrors > 0 ? ' · $extErrors error' : ''}', style: text.labelSmall),
                ])),
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
            const SizedBox(height: AureonSpacing.lg),

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
