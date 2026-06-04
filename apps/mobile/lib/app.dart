import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import 'providers.dart';
import 'screens/login_screen.dart';
import 'screens/home_shell.dart';

class SupremeApp extends ConsumerWidget {
  const SupremeApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return MaterialApp(
      title: 'Supreme OS',
      debugShowCheckedModeBanner: false,
      theme: AureonTheme.dark(),
      home: const _Root(),
    );
  }
}

/// Routes between the Supreme-branded login and the room-first home once
/// authenticated. There is never any backend (HA) login surface.
class _Root extends ConsumerStatefulWidget {
  const _Root();

  @override
  ConsumerState<_Root> createState() => _RootState();
}

class _RootState extends ConsumerState<_Root> {
  bool _authed = false;

  Future<void> _onAuthenticated() async {
    final client = ref.read(clientProvider);
    final stream = SupremeStream(
      wsBaseUrl: ref.read(hubWsUrlProvider),
      accessToken: client.accessToken!,
    )..connect();
    ref.read(streamProvider.notifier).state = stream;
    setState(() => _authed = true);
  }

  @override
  Widget build(BuildContext context) {
    if (!_authed) {
      return LoginScreen(onAuthenticated: _onAuthenticated);
    }
    return const HomeShell();
  }
}
