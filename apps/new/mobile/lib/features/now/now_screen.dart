import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// Concise live overview of what the residence is doing (§5). Placeholder
/// empty state until live device/state feed is wired (§43) — deliberately
/// honest rather than fabricated activity.
class NowScreen extends StatelessWidget {
  const NowScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    return Center(
      child: Text('Nothing active right now',
          style: text.body.copyWith(color: SupremeColorScheme.textSecondary)),
    );
  }
}
