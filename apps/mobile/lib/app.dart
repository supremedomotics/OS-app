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
    final accent = ref.watch(accentProvider);
    final mode = ref.watch(themeModeProvider);
    return MaterialApp(
      title: 'Supreme OS',
      debugShowCheckedModeBanner: false,
      theme: AureonTheme.light(accent: accent),
      darkTheme: AureonTheme.dark(accent: accent),
      themeMode: mode,
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
  @override
  void initState() {
    super.initState();
    // A restored session (persisted refresh token, app relaunch) skips LoginScreen entirely, so it
    // never calls onAuthenticated — establish the WSS stream here instead, once, on first build.
    if (ref.read(sessionActiveProvider)) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _resumeSession());
    }
  }

  /// The persisted access token may be stale (or expired) after however long the app was closed —
  /// the HTTP interceptor refreshes-and-retries transparently, but the WSS handshake needs a good
  /// token up front. Refresh proactively before opening the stream; if the refresh token is also
  /// dead, `onSessionExpired` already dropped us to the login screen and this is a no-op.
  Future<void> _resumeSession() async {
    try {
      await ref.read(clientProvider).refresh();
    } catch (_) {
      return; // onSessionExpired handled it
    }
    if (ref.read(sessionActiveProvider)) await _onAuthenticated();
  }

  Future<void> _onAuthenticated() async {
    final client = ref.read(clientProvider);
    final stream = SupremeStream(
      wsBaseUrl: ref.read(hubWsUrlProvider),
      accessToken: client.accessToken!,
    )..connect();
    // The "*" wildcard subscribes to every room in one go — liveStatesProvider fans this out to
    // every screen, so individual screens no longer need their own per-room subscribe/listener.
    stream.subscribe(const ["*"]);
    ref.read(streamProvider.notifier).state = stream;
    ref.read(sessionActiveProvider.notifier).state = true;
  }

  @override
  Widget build(BuildContext context) {
    if (!ref.watch(sessionActiveProvider)) {
      return LoginScreen(onAuthenticated: _onAuthenticated);
    }
    return const HomeShell();
  }
}
