import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import '../widgets/password_field.dart';

/// Appearance settings (§11.2 Themes): Light / Dark / Automatic base palettes
/// (Luxury Black / Luxury White) and the accent colour (Gold / Silver). Changing a
/// setting rebuilds the MaterialApp theme instantly.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeModeProvider);
    final accent = ref.watch(accentProvider);

    return Scaffold(
      appBar: AppBar(title: const Text('Settings')),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.md),
        children: [
          Text('Appearance', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.md),
          const _Label('Theme'),
          SegmentedButton<ThemeMode>(
            segments: const [
              ButtonSegment(value: ThemeMode.light, label: Text('Luxury White'), icon: Icon(Icons.light_mode_outlined)),
              ButtonSegment(value: ThemeMode.dark, label: Text('Luxury Black'), icon: Icon(Icons.dark_mode_outlined)),
              ButtonSegment(value: ThemeMode.system, label: Text('Automatic'), icon: Icon(Icons.brightness_auto_outlined)),
            ],
            selected: {mode},
            onSelectionChanged: (s) => ref.read(themeModeProvider.notifier).state = s.first,
            showSelectedIcon: false,
          ),
          const SizedBox(height: AureonSpacing.lg),
          const _Label('Accent'),
          SegmentedButton<AureonAccent>(
            segments: const [
              ButtonSegment(value: AureonAccent.gold, label: Text('Gold'), icon: Icon(Icons.circle, color: AureonGold.c400)),
              ButtonSegment(value: AureonAccent.silver, label: Text('Silver'), icon: Icon(Icons.circle, color: Color(0xFFC8CDD6))),
            ],
            selected: {accent},
            onSelectionChanged: (s) => ref.read(accentProvider.notifier).state = s.first,
            showSelectedIcon: false,
          ),
          const SizedBox(height: AureonSpacing.xl),
          Text('Account', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.sm),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.password_outlined),
            title: const Text('Change password'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _changePassword(context, ref),
          ),
        ],
      ),
    );
  }

  Future<void> _changePassword(BuildContext context, WidgetRef ref) async {
    final current = TextEditingController();
    final next = TextEditingController();
    final confirm = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Change password'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              PasswordField(controller: current, label: 'Current password'),
              const SizedBox(height: AureonSpacing.sm),
              PasswordField(controller: next, label: 'New password (min 8)'),
              const SizedBox(height: AureonSpacing.sm),
              PasswordField(controller: confirm, label: 'Confirm new password'),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Update')),
        ],
      ),
    );
    if (saved == true) {
      if (next.text.length < 8) {
        messenger.showSnackBar(const SnackBar(content: Text('Password must be at least 8 characters')));
      } else if (next.text != confirm.text) {
        messenger.showSnackBar(const SnackBar(content: Text('Passwords do not match')));
      } else {
        try {
          await ref.read(clientProvider).changePassword(current.text, next.text);
          messenger.showSnackBar(const SnackBar(content: Text('Password updated')));
        } catch (_) {
          messenger.showSnackBar(const SnackBar(content: Text('Could not change password. Check your current password.')));
        }
      }
    }
    current.dispose();
    next.dispose();
    confirm.dispose();
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
        child: Text(text, style: Theme.of(context).textTheme.labelMedium),
      );
}
