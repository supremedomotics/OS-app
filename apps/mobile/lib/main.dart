import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'app.dart';
import 'providers.dart';

/// Entry point for the Supreme OS homeowner app. Local-first: it talks to the hub
/// over the Supreme API (LAN-direct, or via the optional cloud relay when away) —
/// the homeowner never configures a URL or sees any backend (HA) branding.
///
/// Local prefs (theme, accent, weather location) are loaded once up front so the
/// providers that persist them can read their saved value synchronously.
Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final prefs = await SharedPreferences.getInstance();
  runApp(ProviderScope(
    overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
    child: const SupremeApp(),
  ));
}
