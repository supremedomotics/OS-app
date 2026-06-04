import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Supreme-branded sign in (§12). A Supreme account — never a backend login page.
class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key, required this.onAuthenticated});

  final Future<void> Function() onAuthenticated;

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _email = TextEditingController(text: 'owner@supreme.local');
  final _password = TextEditingController(text: 'supreme-owner-demo-pass');
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final client = ref.read(clientProvider);
      final ok = await client.login(_email.text, _password.text);
      if (ok) {
        await widget.onAuthenticated();
      } else {
        setState(() => _error = 'Two-factor authentication required');
      }
    } catch (_) {
      setState(() => _error = 'Could not sign in. Check your details.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 420),
          child: Padding(
            padding: const EdgeInsets.all(AureonSpacing.xl),
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('Supreme',
                    style: Theme.of(context).textTheme.displayLarge),
                const SizedBox(height: AureonSpacing.sm),
                Text('Welcome home',
                    style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: AureonSpacing.xl),
                TextField(
                  controller: _email,
                  decoration: const InputDecoration(labelText: 'Email'),
                  keyboardType: TextInputType.emailAddress,
                ),
                const SizedBox(height: AureonSpacing.md),
                TextField(
                  controller: _password,
                  decoration: const InputDecoration(labelText: 'Password'),
                  obscureText: true,
                ),
                const SizedBox(height: AureonSpacing.lg),
                if (_error != null) ...[
                  Text(_error!,
                      style: const TextStyle(color: AureonStatus.critical)),
                  const SizedBox(height: AureonSpacing.md),
                ],
                FilledButton(
                  onPressed: _busy ? null : _submit,
                  child: _busy
                      ? const SizedBox(
                          height: 18,
                          width: 18,
                          child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Sign in'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
