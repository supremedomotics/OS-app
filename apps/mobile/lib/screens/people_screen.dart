import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../errors.dart';
import '../providers.dart';
import '../widgets/password_field.dart';

/// Every user in the home, for the People screen's role dropdowns + create form.
final _usersProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).listUsers());

/// The roles offered in the "Create User" form and per-row role picker.
final _rolesProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).roles());

/// Settings → People (§8 "admin account settings"): the master/admin's user-management
/// screen — list every account in the home, create a new one, and assign its role
/// (Installer, Developer, Homeowner, …). Role changes here are what drive the rest of the
/// app's role-adaptive UI (see providers.dart `userRoleProvider`) for that account's next
/// sign-in, on phone and tablet alike.
class PeopleScreen extends ConsumerWidget {
  const PeopleScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final users = ref.watch(_usersProvider);
    final roles = ref.watch(_rolesProvider);
    final self = ref.watch(meProvider).valueOrNull;
    final selfId = self?['id'] as String?;

    return Scaffold(
      appBar: AppBar(title: const Text('People')),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _createUser(context, ref),
        icon: const Icon(Icons.person_add_alt_outlined),
        label: const Text('Create user'),
      ),
      body: users.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text(friendlyError(e))),
        data: (list) {
          final roleList = roles.valueOrNull ?? const [];
          if (list.isEmpty) return const Center(child: Text('No users yet.'));
          return RefreshIndicator(
            onRefresh: () async { ref.invalidate(_usersProvider); },
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                Text('Everyone with access to this home, and what they can do. Assign a role to change '
                    'what someone sees and controls across web, tablet and mobile.',
                    style: Theme.of(context).textTheme.bodyMedium),
                const SizedBox(height: AureonSpacing.md),
                for (final u in list) _PersonTile(user: u, roles: roleList, isSelf: u['id'] == selfId, onChanged: () => ref.invalidate(_usersProvider)),
              ],
            ),
          );
        },
      ),
    );
  }

  Future<void> _createUser(BuildContext context, WidgetRef ref) async {
    final roles = (ref.read(_rolesProvider).valueOrNull ?? const [])
        .where((r) => r['key'] != 'master')
        .toList();
    final name = TextEditingController();
    final email = TextEditingController();
    final password = TextEditingController();
    String role = roles.any((r) => r['key'] == 'homeowner') ? 'homeowner' : (roles.isNotEmpty ? roles.first['key'] as String : 'homeowner');
    final messenger = ScaffoldMessenger.of(context);

    final created = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => StatefulBuilder(
        builder: (dialogContext, setState) => AlertDialog(
          title: const Text('Create user'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                TextField(controller: name, decoration: const InputDecoration(labelText: 'Full name')),
                const SizedBox(height: AureonSpacing.sm),
                TextField(controller: email, keyboardType: TextInputType.emailAddress, decoration: const InputDecoration(labelText: 'Email')),
                const SizedBox(height: AureonSpacing.sm),
                PasswordField(controller: password, label: 'Initial password (min 8)'),
                const SizedBox(height: AureonSpacing.sm),
                DropdownButtonFormField<String>(
                  initialValue: role,
                  decoration: const InputDecoration(labelText: 'Role'),
                  items: [for (final r in roles) DropdownMenuItem(value: r['key'] as String, child: Text(r['label'] as String))],
                  onChanged: (v) => setState(() => role = v ?? role),
                ),
                if (roles.any((r) => r['key'] == role))
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: Text(
                      roles.firstWhere((r) => r['key'] == role)['description'] as String? ?? '',
                      style: Theme.of(dialogContext).textTheme.labelSmall,
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
            FilledButton(onPressed: () => Navigator.pop(dialogContext, true), child: const Text('Create')),
          ],
        ),
      ),
    );

    if (created == true) {
      if (name.text.trim().isEmpty || email.text.trim().isEmpty) {
        messenger.showSnackBar(const SnackBar(content: Text('Name and email are required')));
      } else if (password.text.length < 8) {
        messenger.showSnackBar(const SnackBar(content: Text('Password must be at least 8 characters')));
      } else {
        try {
          await ref.read(clientProvider).createUser(
                email: email.text.trim(),
                password: password.text,
                displayName: name.text.trim(),
                userType: role,
              );
          ref.invalidate(_usersProvider);
          messenger.showSnackBar(const SnackBar(content: Text('User created')));
        } catch (e) {
          messenger.showSnackBar(SnackBar(content: Text(friendlyError(e))));
        }
      }
    }
    name.dispose();
    email.dispose();
    password.dispose();
  }
}

class _PersonTile extends ConsumerWidget {
  const _PersonTile({required this.user, required this.roles, required this.isSelf, required this.onChanged});
  final Map<String, dynamic> user;
  final List<Map<String, dynamic>> roles;
  final bool isSelf;
  final VoidCallback onChanged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final id = user['id'] as String;
    final displayName = user['displayName'] as String? ?? '';
    final email = user['email'] as String? ?? '';
    final userType = user['userType'] as String? ?? 'homeowner';
    final status = user['status'] as String? ?? 'active';
    final verified = user['emailVerified'] == true;
    final isMaster = userType == 'master';
    final locked = isMaster || isSelf;

    return Card(
      margin: const EdgeInsets.only(bottom: AureonSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.sm),
        child: Row(children: [
          Icon(isMaster ? Icons.star_outline : Icons.person_outline, color: isMaster ? AureonGold.c400 : null),
          const SizedBox(width: AureonSpacing.sm),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Flexible(child: Text(displayName, style: const TextStyle(fontWeight: FontWeight.w600), overflow: TextOverflow.ellipsis)),
                if (isSelf) const Padding(padding: EdgeInsets.only(left: 6), child: Chip(label: Text('You'), visualDensity: VisualDensity.compact)),
                if (status == 'suspended')
                  Padding(padding: const EdgeInsets.only(left: 6), child: Chip(label: const Text('Suspended'), visualDensity: VisualDensity.compact, backgroundColor: AureonStatus.warning.withValues(alpha: 0.15))),
                if (status == 'expired')
                  const Padding(padding: EdgeInsets.only(left: 6), child: Chip(label: Text('Expired'), visualDensity: VisualDensity.compact)),
              ]),
              Text('$email${verified ? '' : ' · unverified'}', style: Theme.of(context).textTheme.labelSmall),
            ]),
          ),
          PopupMenuButton<String>(
            enabled: !locked,
            initialValue: userType,
            tooltip: locked ? (isMaster ? "The Super Administrator's role can't be changed" : "You can't change your own role") : 'Change role',
            onSelected: (v) => _changeRole(context, ref, id, v),
            itemBuilder: (menuContext) => [
              for (final r in roles.where((r) => r['key'] != 'master'))
                PopupMenuItem(value: r['key'] as String, child: Text(r['label'] as String)),
            ],
            child: Chip(
              label: Text(roles.firstWhere((r) => r['key'] == userType, orElse: () => {'label': userType})['label'] as String),
              avatar: locked ? null : const Icon(Icons.expand_more, size: 16),
            ),
          ),
          if (!locked) ...[
            IconButton(
              tooltip: status == 'suspended' ? 'Reactivate' : 'Suspend',
              icon: Icon(status == 'suspended' ? Icons.play_circle_outline : Icons.pause_circle_outline),
              onPressed: () => _toggleStatus(context, ref, id, status),
            ),
            IconButton(
              tooltip: 'Remove',
              icon: const Icon(Icons.delete_outline, color: AureonStatus.critical),
              onPressed: () => _remove(context, ref, id, displayName, email),
            ),
          ],
        ]),
      ),
    );
  }

  Future<void> _changeRole(BuildContext context, WidgetRef ref, String id, String userType) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      await ref.read(clientProvider).updateUserRole(id, userType);
      onChanged();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e))));
    }
  }

  Future<void> _toggleStatus(BuildContext context, WidgetRef ref, String id, String status) async {
    final messenger = ScaffoldMessenger.of(context);
    try {
      if (status == 'suspended') {
        await ref.read(clientProvider).reactivateUser(id);
      } else {
        await ref.read(clientProvider).suspendUser(id);
      }
      onChanged();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e))));
    }
  }

  Future<void> _remove(BuildContext context, WidgetRef ref, String id, String name, String email) async {
    final messenger = ScaffoldMessenger.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('Remove user'),
        content: Text("Remove $name ($email)? This can't be undone."),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dialogContext, false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: AureonStatus.critical),
            onPressed: () => Navigator.pop(dialogContext, true),
            child: const Text('Remove'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await ref.read(clientProvider).deleteUser(id);
      onChanged();
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text(friendlyError(e))));
    }
  }
}
