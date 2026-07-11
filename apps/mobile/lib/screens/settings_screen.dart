import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../cloud/multi_home.dart';
import '../errors.dart';
import '../providers.dart';
import '../widgets/password_field.dart';
import 'add_home_screen.dart';
import 'advanced_settings_screen.dart';
import 'audit_screen.dart';
import 'backup_screen.dart';
import 'people_screen.dart';
import 'security_sessions_screen.dart';
import 'software_update_screen.dart';

/// Appearance settings (§11.2 Themes): Light / Dark / Automatic base palettes
/// (Luxury Black / Luxury White) and the accent colour (Gold / Silver). Changing a
/// setting rebuilds the MaterialApp theme instantly.
class SettingsScreen extends ConsumerWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final mode = ref.watch(themeModeProvider);
    final accent = ref.watch(accentProvider);
    // Only the home's Super Administrator / Administrator manage other accounts (§8).
    final isAdmin = ref.watch(isAdminProvider).valueOrNull ?? false;

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
            onSelectionChanged: (s) => ref.read(themeModeProvider.notifier).set(s.first),
            showSelectedIcon: false,
          ),
          const SizedBox(height: AureonSpacing.lg),
          const _Label('Accent'),
          SegmentedButton<AureonAccent>(
            segments: const [
              ButtonSegment(value: AureonAccent.gold, label: Text('Warm'), icon: Icon(Icons.circle, color: AureonGold.c400)),
              ButtonSegment(value: AureonAccent.silver, label: Text('Silver'), icon: Icon(Icons.circle, color: Color(0xFFC8CDD6))),
            ],
            selected: {accent},
            onSelectionChanged: (s) => ref.read(accentProvider.notifier).set(s.first),
            showSelectedIcon: false,
          ),
          const SizedBox(height: AureonSpacing.xl),
          Text('Homes', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.sm),
          const _HomesSection(),
          const SizedBox(height: AureonSpacing.xl),
          Text('System', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.sm),
          if (isAdmin)
            ListTile(
              contentPadding: EdgeInsets.zero,
              leading: const Icon(Icons.people_outline),
              title: const Text('People'),
              subtitle: const Text('Add users & assign roles'),
              trailing: const Icon(Icons.chevron_right),
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute<void>(builder: (_) => const PeopleScreen()),
              ),
            ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.tune_outlined),
            title: const Text('Advanced'),
            subtitle: const Text('Circadian, climate, ventilation, energy'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AdvancedSettingsScreen()),
            ),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.receipt_long_outlined),
            title: const Text('Audit log'),
            subtitle: const Text('Tamper-evident activity trail'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute<void>(builder: (_) => const AuditScreen()),
            ),
          ),
          const SizedBox(height: AureonSpacing.lg),
          Text('Account', style: Theme.of(context).textTheme.headlineSmall),
          const SizedBox(height: AureonSpacing.sm),
          const _VerifyEmailTile(),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.alternate_email_outlined),
            title: const Text('Change email'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _changeEmail(context, ref),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.password_outlined),
            title: const Text('Change password'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _changePassword(context, ref),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.security_outlined),
            title: const Text('Security & sign-in'),
            subtitle: const Text('Active sessions & devices'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SecuritySessionsScreen())),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.backup_outlined),
            title: const Text('Backup & restore'),
            subtitle: const Text('Backups, schedule & restore'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const BackupScreen())),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.system_update_outlined),
            title: const Text('Software update'),
            subtitle: const Text('Version & updates'),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => const SoftwareUpdateScreen())),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.logout),
            title: const Text('Log out'),
            subtitle: const Text('Sign out of this device'),
            onTap: () => _logOut(context, ref),
          ),
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.delete_outline, color: AureonStatus.critical),
            title: const Text('Delete account', style: TextStyle(color: AureonStatus.critical)),
            trailing: const Icon(Icons.chevron_right),
            onTap: () => _deleteAccount(context, ref),
          ),
        ],
      ),
    );
  }

  Future<void> _changeEmail(BuildContext context, WidgetRef ref) async {
    final email = TextEditingController();
    final password = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final saved = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Change email'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'New email address')),
              const SizedBox(height: AureonSpacing.sm),
              PasswordField(controller: password, label: 'Current password'),
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
      try {
        final user = await ref.read(clientProvider).changeEmail(email.text.trim(), password.text);
        messenger.showSnackBar(SnackBar(content: Text('Email updated to ${user['email']}')));
      } catch (_) {
        messenger.showSnackBar(const SnackBar(content: Text('Could not change email. Check your password and try a different address.')));
      }
    }
    email.dispose();
    password.dispose();
  }

  Future<void> _deleteAccount(BuildContext context, WidgetRef ref) async {
    final password = TextEditingController();
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Delete account'),
        content: SingleChildScrollView(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              const Text('This permanently deletes your account and signs you out everywhere. It can’t be undone. The home owner (master) account can’t be deleted.'),
              const SizedBox(height: AureonSpacing.sm),
              PasswordField(controller: password, label: 'Confirm with your current password'),
            ],
          ),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AureonStatus.critical),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      try {
        await ref.read(clientProvider).deleteAccount(password.text);
        // Account (and its sessions) are gone — clear the persisted session and return to login.
        await logOut(ref);
      } catch (_) {
        messenger.showSnackBar(const SnackBar(content: Text('Could not delete account. Check your password.')));
      }
    }
    password.dispose();
  }

  Future<void> _logOut(BuildContext context, WidgetRef ref) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Log out'),
        content: const Text('You’ll need to sign in again on this device.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Log out')),
        ],
      ),
    );
    if (confirmed == true) await logOut(ref);
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

/// The homes this app can reach (§16): tap to switch the active home instantly; "Add a home" opens
/// the setup screen. Self-explanatory when there's a single (or no) home yet.
class _HomesSection extends ConsumerWidget {
  const _HomesSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final homes = ref.watch(homesProvider);
    final active = ref.watch(activeHomeProvider);
    final theme = Theme.of(context);
    return Column(
      children: [
        for (final home in homes)
          ListTile(
            contentPadding: EdgeInsets.zero,
            leading: Icon(home.isLocalReachable ? Icons.wifi_rounded : Icons.cloud_outlined,
                color: home.hubId == active?.hubId ? theme.colorScheme.primary : theme.colorScheme.onSurfaceVariant),
            title: Text(home.name),
            subtitle: Text(home.localBaseUrl ?? home.cloudRouteUrl, style: theme.textTheme.labelSmall),
            trailing: home.hubId == active?.hubId ? Icon(Icons.check_circle, color: theme.colorScheme.primary) : null,
            onTap: () => ref.read(activeHomeIdProvider.notifier).state = home.hubId,
          ),
        ListTile(
          contentPadding: EdgeInsets.zero,
          leading: Icon(Icons.add_home_outlined, color: theme.colorScheme.primary),
          title: Text('Add a home', style: TextStyle(color: theme.colorScheme.primary)),
          trailing: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const AddHomeScreen()),
          ),
        ),
      ],
    );
  }
}

/// The signed-in user (incl. emailVerified) for the verification banner (§ email verification).
final _meProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).me());

class _VerifyEmailTile extends ConsumerWidget {
  const _VerifyEmailTile();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final me = ref.watch(_meProvider).valueOrNull;
    if (me == null) return const SizedBox.shrink();
    final verified = me['emailVerified'] == true;
    final email = me['email'] as String? ?? '';
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(verified ? Icons.verified_outlined : Icons.mark_email_unread_outlined,
          color: verified ? AureonStatus.good : AureonStatus.warning),
      title: Text(email),
      subtitle: Text(verified ? 'Email verified' : 'Email not verified'),
      trailing: verified
          ? null
          : TextButton(
              onPressed: () async {
                final messenger = ScaffoldMessenger.of(context);
                try {
                  final res = await ref.read(clientProvider).requestEmailVerification();
                  if (res['token'] != null) {
                    await ref.read(clientProvider).verifyEmail(res['token'] as String);
                    ref.invalidate(_meProvider);
                    messenger.showSnackBar(const SnackBar(content: Text('Email verified')));
                  } else {
                    messenger.showSnackBar(const SnackBar(content: Text('Verification email sent — check your inbox')));
                  }
                } catch (e) {
                  messenger.showSnackBar(SnackBar(content: Text(friendlyError(e))));
                }
              },
              child: const Text('Verify'),
            ),
    );
  }
}
