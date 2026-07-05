import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';
import '../widgets/password_field.dart';

/// Forgotten-password reset (§12). Step 1: request a reset for an email — on a local hub the hub
/// hands back a one-time token immediately; in production it's emailed. Step 2: enter the token + a
/// new password (with a show/hide toggle) and submit.
class ResetPasswordScreen extends ConsumerStatefulWidget {
  const ResetPasswordScreen({super.key, this.initialEmail = ''});

  final String initialEmail;

  @override
  ConsumerState<ResetPasswordScreen> createState() => _ResetPasswordScreenState();
}

class _ResetPasswordScreenState extends ConsumerState<ResetPasswordScreen> {
  late final TextEditingController _email = TextEditingController(text: widget.initialEmail);
  final _token = TextEditingController();
  final _newPassword = TextEditingController();
  bool _busy = false;
  bool _requested = false;
  String? _error;
  String? _info;

  @override
  void dispose() {
    _email.dispose();
    _token.dispose();
    _newPassword.dispose();
    super.dispose();
  }

  Future<void> _request() async {
    setState(() {
      _busy = true;
      _error = null;
      _info = null;
    });
    try {
      final token = await ref.read(clientProvider).forgotPassword(_email.text.trim());
      setState(() {
        _requested = true;
        if (token != null) {
          _token.text = token; // local hub: prefill so the user can reset immediately
          _info = 'Reset token ready. Choose a new password below.';
        } else {
          _info = 'If that account exists, reset instructions have been sent.';
        }
      });
    } catch (_) {
      setState(() => _error = 'Could not start the reset. Check the email and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _reset() async {
    if (_newPassword.text.length < 8) {
      setState(() => _error = 'Password must be at least 8 characters.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    try {
      await ref.read(clientProvider).resetPassword(_token.text.trim(), _newPassword.text);
      messenger.showSnackBar(const SnackBar(content: Text('Password updated. Please sign in.')));
      navigator.pop();
    } catch (_) {
      setState(() => _error = 'Could not reset. The token may be invalid or expired.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Reset password')),
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.all(AureonSpacing.xl),
            children: [
              TextField(
                controller: _email,
                decoration: const InputDecoration(labelText: 'Email'),
                keyboardType: TextInputType.emailAddress,
              ),
              const SizedBox(height: AureonSpacing.md),
              if (!_requested)
                FilledButton(
                  onPressed: _busy ? null : _request,
                  child: _busy ? const _Spinner() : const Text('Send reset link'),
                ),
              if (_requested) ...[
                TextField(controller: _token, decoration: const InputDecoration(labelText: 'Reset token')),
                const SizedBox(height: AureonSpacing.md),
                PasswordField(controller: _newPassword, label: 'New password', onSubmitted: (_) => _reset()),
                const SizedBox(height: AureonSpacing.lg),
                FilledButton(
                  onPressed: _busy ? null : _reset,
                  child: _busy ? const _Spinner() : const Text('Set new password'),
                ),
              ],
              if (_info != null) ...[
                const SizedBox(height: AureonSpacing.md),
                Text(_info!, style: text.labelMedium),
              ],
              if (_error != null) ...[
                const SizedBox(height: AureonSpacing.md),
                Text(_error!, style: const TextStyle(color: AureonStatus.critical)),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Spinner extends StatelessWidget {
  const _Spinner();
  @override
  Widget build(BuildContext context) => const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2));
}
