import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../cloud/multi_home.dart';
import '../providers.dart';

/// Home switcher (blueprint §16): a pull-up sheet listing every home the account can access
/// (Mumbai Villa, Dubai Apartment, Farmhouse, …). Tapping one switches the active home
/// INSTANTLY — no logout — by setting [activeHomeIdProvider]; every screen rebuilds against the
/// new home's resolved connection. Each row shows how that home is currently reached.
class HomeSwitcherSheet extends ConsumerWidget {
  const HomeSwitcherSheet({super.key});

  static Future<void> show(BuildContext context) => showModalBottomSheet<void>(
        context: context,
        backgroundColor: Colors.transparent,
        isScrollControlled: true,
        builder: (_) => const HomeSwitcherSheet(),
      );

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final homes = ref.watch(homesProvider);
    final active = ref.watch(activeHomeProvider);
    final theme = Theme.of(context);

    return SafeArea(
      child: Container(
        margin: const EdgeInsets.all(12),
        padding: const EdgeInsets.symmetric(vertical: 16),
        decoration: BoxDecoration(
          color: theme.colorScheme.surface,
          borderRadius: BorderRadius.circular(24),
        ),
        clipBehavior: Clip.antiAlias,
        // A Material ancestor so the ListTile rows can paint ink/splashes correctly.
        child: Material(
          type: MaterialType.transparency,
          child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 12),
              child: Text('Homes', style: theme.textTheme.titleLarge),
            ),
            if (homes.isEmpty)
              const Padding(
                padding: EdgeInsets.all(20),
                child: Text('No homes yet — claim a hub to add your first home.'),
              )
            else
              ...homes.map((home) => _HomeTile(
                    home: home,
                    selected: home.hubId == active?.hubId,
                    onTap: () {
                      ref.read(activeHomeIdProvider.notifier).state = home.hubId;
                      Navigator.of(context).pop();
                    },
                  )),
          ],
          ),
        ),
      ),
    );
  }
}

class _HomeTile extends StatelessWidget {
  const _HomeTile({required this.home, required this.selected, required this.onTap});
  final HomeRef home;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // A home is shown as "On this network" when a verified LAN path exists, else "Remote".
    final local = home.isLocalReachable;
    return ListTile(
      onTap: onTap,
      leading: Icon(local ? Icons.wifi_rounded : Icons.cloud_outlined,
          color: local ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant),
      title: Text(home.name),
      subtitle: Text('${_titleCase(home.role)} · ${local ? 'On this network' : 'Remote'}'),
      trailing: selected ? Icon(Icons.check_circle, color: theme.colorScheme.primary) : null,
    );
  }

  String _titleCase(String s) => s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
}

/// A compact button for the app bar that opens the switcher and shows the active home + how
/// it is currently reached (local vs cloud) — the transparent-switching status affordance.
class HomeSwitcherButton extends ConsumerWidget {
  const HomeSwitcherButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final active = ref.watch(activeHomeProvider);
    final mode = ref.watch(connectionModeProvider);
    final theme = Theme.of(context);
    if (active == null) return const SizedBox.shrink();

    final (icon, label) = switch (mode) {
      ConnectionMode.local => (Icons.wifi_rounded, 'Local'),
      ConnectionMode.cloud => (Icons.cloud_outlined, 'Remote'),
      ConnectionMode.offline => (Icons.cloud_off_rounded, 'Offline'),
    };

    return TextButton.icon(
      onPressed: () => HomeSwitcherSheet.show(context),
      icon: Icon(icon, size: 18),
      label: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(active.name, style: theme.textTheme.titleMedium),
          Text(label, style: theme.textTheme.labelSmall),
        ],
      ),
    );
  }
}
