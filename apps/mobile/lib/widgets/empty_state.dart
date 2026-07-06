import 'package:flutter/material.dart';

/// EmptyState (§ Empty States) — one calm, consistent way to present a page with nothing in it yet,
/// mirroring the web app. Never a blank screen: a quiet icon, a plain-language line about what would
/// live here, and — when there's a sensible next step — a single action to get there.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.title, this.hint, this.actionLabel, this.onAction});

  final IconData icon;
  final String title;
  final String? hint;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 32, vertical: 40),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: scheme.onSurfaceVariant.withValues(alpha: 0.7)),
            const SizedBox(height: 12),
            Text(title, style: text.titleMedium, textAlign: TextAlign.center),
            if (hint != null) ...[
              const SizedBox(height: 6),
              Text(hint!, style: text.bodySmall?.copyWith(color: scheme.onSurfaceVariant), textAlign: TextAlign.center),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 16),
              FilledButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ],
        ),
      ),
    );
  }
}
