import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Security & sign-in (§ Security Center) — mobile parity. Lists the user's login sessions, flags the
/// current device, and supports remote logout (one session, or everywhere else). IP / device /
/// last-seen shown when captured.
final _sessionsProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).sessions());
final _recoveryProvider = FutureProvider<Map<String, dynamic>>((ref) => ref.watch(clientProvider).recoveryCodeStatus());
final _apiTokensProvider = FutureProvider<List<Map<String, dynamic>>>((ref) => ref.watch(clientProvider).apiTokens());

/// Computed security posture (§ Security Center) from real signals: MFA, recovery codes, passkey,
/// verified email. Returns {value, missing}.
final _securityScoreProvider = FutureProvider<Map<String, dynamic>>((ref) async {
  final c = ref.watch(clientProvider);
  final rec = await c.recoveryCodeStatus().catchError((_) => <String, dynamic>{'mfaEnabled': false, 'remaining': 0});
  final me = await c.me().catchError((_) => <String, dynamic>{'emailVerified': false});
  // Passkeys are managed on the web (no mobile authenticator UI), so they're not scored here.
  final items = <(bool, String, int)>[
    (rec['mfaEnabled'] == true, 'Two-factor authentication', 40),
    ((rec['remaining'] as num? ?? 0) > 0, 'Recovery codes', 20),
    (me['emailVerified'] == true, 'Email verified', 15),
  ];
  var value = 25;
  final missing = <String>[];
  for (final (ok, text, w) in items) {
    if (ok) { value += w; } else { missing.add(text); }
  }
  return {'value': value > 100 ? 100 : value, 'missing': missing};
});

class SecuritySessionsScreen extends ConsumerWidget {
  const SecuritySessionsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessions = ref.watch(_sessionsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Security & sign-in')),
      body: sessions.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load sessions\n$e', textAlign: TextAlign.center)),
        data: (list) {
          final active = list.where((s) => s['revoked'] != true).toList();
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(_sessionsProvider),
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                const _SecurityScoreCard(),
                const SizedBox(height: AureonSpacing.md),
                Text('Devices signed in to your account. Sign out any you don’t recognise.',
                    style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: AureonSpacing.md),
                if (active.length > 1)
                  OutlinedButton.icon(
                    icon: const Icon(Icons.logout, size: 18),
                    label: const Text('Sign out all other sessions'),
                    onPressed: () async {
                      final messenger = ScaffoldMessenger.of(context);
                      try {
                        final n = await ref.read(clientProvider).revokeOtherSessions();
                        ref.invalidate(_sessionsProvider);
                        messenger.showSnackBar(SnackBar(content: Text(n > 0 ? 'Signed out $n other session${n == 1 ? '' : 's'}' : 'No other sessions')));
                      } catch (_) {
                        messenger.showSnackBar(const SnackBar(content: Text('Could not sign out other sessions')));
                      }
                    },
                  ),
                const SizedBox(height: AureonSpacing.sm),
                for (final s in active) _SessionTile(session: s, onRevoked: () => ref.invalidate(_sessionsProvider)),
                const Divider(height: 28),
                const _RecoveryCodes(),
                const Divider(height: 28),
                const _ApiTokens(),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _SessionTile extends ConsumerWidget {
  const _SessionTile({required this.session, required this.onRevoked});
  final Map<String, dynamic> session;
  final VoidCallback onRevoked;

  static String _shortAgent(String? ua) {
    if (ua == null || ua.isEmpty) return 'Unknown device';
    final os = RegExp('Windows').hasMatch(ua)
        ? 'Windows'
        : RegExp('iPhone|iPad|iOS').hasMatch(ua)
            ? 'iOS'
            : RegExp('Mac OS X|Macintosh').hasMatch(ua)
                ? 'macOS'
                : RegExp('Android').hasMatch(ua)
                    ? 'Android'
                    : RegExp('Linux').hasMatch(ua)
                        ? 'Linux'
                        : '';
    final br = RegExp('Dart|supreme', caseSensitive: false).hasMatch(ua)
        ? 'Supreme app'
        : RegExp('Edg/').hasMatch(ua)
            ? 'Edge'
            : RegExp('Chrome/').hasMatch(ua)
                ? 'Chrome'
                : RegExp('Firefox/').hasMatch(ua)
                    ? 'Firefox'
                    : RegExp('Safari/').hasMatch(ua)
                        ? 'Safari'
                        : '';
    final label = [br, os].where((x) => x.isNotEmpty).join(' on ');
    return label.isEmpty ? (ua.length > 40 ? ua.substring(0, 40) : ua) : label;
  }

  static String _fmt(String? iso) {
    final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    return d == null ? '—' : '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')} ${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final current = session['current'] == true;
    final ip = session['ip'] as String?;
    final sub = '${ip ?? 'IP unknown'} · signed in ${_fmt(session['createdAt'] as String?)}';
    return Card(
      child: ListTile(
        leading: const Icon(Icons.devices_outlined),
        title: Row(children: [
          Flexible(child: Text(_shortAgent(session['userAgent'] as String?), overflow: TextOverflow.ellipsis)),
          if (current) ...[
            const SizedBox(width: 6),
            const Chip(label: Text('This device', style: TextStyle(fontSize: 10)), visualDensity: VisualDensity.compact, padding: EdgeInsets.zero),
          ],
        ]),
        subtitle: Text(sub, style: Theme.of(context).textTheme.labelSmall),
        trailing: current
            ? null
            : TextButton(
                style: TextButton.styleFrom(foregroundColor: AureonStatus.critical),
                onPressed: () async {
                  final messenger = ScaffoldMessenger.of(context);
                  try {
                    await ref.read(clientProvider).revokeSession(session['id'] as String);
                    onRevoked();
                  } catch (_) {
                    messenger.showSnackBar(const SnackBar(content: Text('Could not sign out that session')));
                  }
                },
                child: const Text('Sign out'),
              ),
      ),
    );
  }
}

/// MFA recovery codes (§ Security Center) — one-time backup codes shown once on generation.
class _RecoveryCodes extends ConsumerStatefulWidget {
  const _RecoveryCodes();
  @override
  ConsumerState<_RecoveryCodes> createState() => _RecoveryCodesState();
}

class _RecoveryCodesState extends ConsumerState<_RecoveryCodes> {
  List<String>? _codes;
  bool _busy = false;

  @override
  Widget build(BuildContext context) {
    final status = ref.watch(_recoveryProvider);
    final text = Theme.of(context).textTheme;
    return status.when(
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (s) {
        final enabled = s['mfaEnabled'] == true;
        final remaining = (s['remaining'] as num?)?.toInt() ?? 0;
        return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Recovery codes', style: text.titleSmall),
          const SizedBox(height: 4),
          if (!enabled)
            Text('Enable two-factor authentication to set up recovery codes.', style: text.labelMedium)
          else ...[
            Text('One-time codes to sign in if you lose your authenticator. $remaining unused.', style: text.labelMedium),
            if (_codes != null) ...[
              const SizedBox(height: 8),
              Wrap(spacing: 8, runSpacing: 8, children: [
                for (final c in _codes!)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                    decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(8), border: Border.all(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.4))),
                    child: Text(c, style: const TextStyle(fontFamily: 'monospace', letterSpacing: 1)),
                  ),
              ]),
              Padding(padding: const EdgeInsets.only(top: 6), child: Text("Save these now — they won't be shown again.", style: text.labelSmall?.copyWith(color: AureonStatus.critical))),
            ],
            const SizedBox(height: 8),
            OutlinedButton(
              onPressed: _busy ? null : () async {
                setState(() => _busy = true);
                final messenger = ScaffoldMessenger.of(context);
                try {
                  final res = await ref.read(clientProvider).generateRecoveryCodes();
                  setState(() => _codes = (res['codes'] as List).cast<String>());
                  ref.invalidate(_recoveryProvider);
                } catch (e) {
                  messenger.showSnackBar(SnackBar(content: Text('Failed: $e')));
                } finally {
                  if (mounted) setState(() => _busy = false);
                }
              },
              child: Text(remaining > 0 ? 'Regenerate codes' : 'Generate recovery codes'),
            ),
          ],
        ]);
      },
    );
  }
}

/// Personal API tokens (§ Security Center) — long-lived Bearer credentials, shown once on creation.
class _ApiTokens extends ConsumerStatefulWidget {
  const _ApiTokens();
  @override
  ConsumerState<_ApiTokens> createState() => _ApiTokensState();
}

class _ApiTokensState extends ConsumerState<_ApiTokens> {
  final TextEditingController _name = TextEditingController();
  String? _created;
  bool _busy = false;

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  String _fmt(String? iso) {
    final d = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
    return d == null ? 'never' : '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final tokens = ref.watch(_apiTokensProvider).valueOrNull ?? const [];
    final text = Theme.of(context).textTheme;
    final messenger = ScaffoldMessenger.of(context);
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('API tokens', style: text.titleSmall),
      const SizedBox(height: 4),
      Text('Long-lived tokens for scripts and integrations. Treat them like passwords.', style: text.labelMedium),
      if (_created != null) ...[
        const SizedBox(height: 8),
        Container(
          padding: const EdgeInsets.all(AureonSpacing.md),
          decoration: BoxDecoration(color: AureonGold.c400.withValues(alpha: 0.08), borderRadius: BorderRadius.circular(AureonRadius.md), border: Border.all(color: AureonGold.c400.withValues(alpha: 0.45))),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            SelectableText(_created!, style: const TextStyle(fontFamily: 'monospace')),
            Padding(padding: const EdgeInsets.only(top: 4), child: Text("Copy it now — it won't be shown again.", style: text.labelSmall?.copyWith(color: AureonStatus.critical))),
          ]),
        ),
      ],
      for (final t in tokens)
        Card(
          child: ListTile(
            leading: const Icon(Icons.key_outlined),
            title: Text('${t['name']}  ${t['prefix']}…'),
            subtitle: Text('created ${_fmt(t['createdAt'] as String?)} · last used ${_fmt(t['lastUsedAt'] as String?)}', style: text.labelSmall),
            trailing: TextButton(
              style: TextButton.styleFrom(foregroundColor: AureonStatus.critical),
              onPressed: _busy ? null : () async {
                try { await ref.read(clientProvider).revokeApiToken(t['id'] as String); ref.invalidate(_apiTokensProvider); }
                catch (e) { messenger.showSnackBar(SnackBar(content: Text('Failed: $e'))); }
              },
              child: const Text('Revoke'),
            ),
          ),
        ),
      const SizedBox(height: 8),
      Row(children: [
        Expanded(child: TextField(controller: _name, decoration: const InputDecoration(labelText: 'Token name'))),
        const SizedBox(width: 8),
        FilledButton(
          onPressed: _busy ? null : () async {
            setState(() => _busy = true);
            try {
              final res = await ref.read(clientProvider).createApiToken(_name.text.trim().isEmpty ? 'API token' : _name.text.trim());
              setState(() => _created = res['token'] as String);
              _name.clear();
              ref.invalidate(_apiTokensProvider);
            } catch (e) {
              messenger.showSnackBar(SnackBar(content: Text('Failed: $e')));
            } finally {
              if (mounted) setState(() => _busy = false);
            }
          },
          child: const Text('Create'),
        ),
      ]),
    ]);
  }
}

/// The computed security-score card at the top of Security & sign-in.
class _SecurityScoreCard extends ConsumerWidget {
  const _SecurityScoreCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final s = ref.watch(_securityScoreProvider).valueOrNull;
    if (s == null) return const SizedBox.shrink();
    final value = s['value'] as int;
    final missing = (s['missing'] as List).cast<String>();
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final good = value >= 85;
    return Container(
      padding: const EdgeInsets.all(AureonSpacing.md),
      decoration: BoxDecoration(color: AureonBase.surface, borderRadius: BorderRadius.circular(AureonRadius.lg), border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4))),
      child: Row(children: [
        Container(width: 12, height: 12, decoration: BoxDecoration(shape: BoxShape.circle, color: good ? AureonStatus.good : AureonStatus.warning)),
        const SizedBox(width: 14),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Security score $value/100', style: text.titleMedium),
          Text(missing.isEmpty ? 'Fully protected' : 'To improve: ${missing.join(', ')}', style: text.labelSmall),
        ])),
        Text('$value', style: text.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
      ]),
    );
  }
}
