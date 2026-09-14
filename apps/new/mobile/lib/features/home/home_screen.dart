import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// "What is happening in the residence" (§5) — a calm overview, never a
/// device dashboard.
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final manager = ref.watch(connectionManagerProvider);
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return StreamBuilder<HubConnectionState>(
      stream: manager.state,
      initialData: manager.current,
      builder: (context, snap) {
        final status = snap.data?.status ?? ConnectionStatus.offline;
        return Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Good afternoon', style: text.label),
              const SizedBox(height: 4),
              Text('Your home', style: text.title),
              const SizedBox(height: 32),
              ConnectionStateIndicator(status: status),
            ],
          ),
        );
      },
    );
  }
}
