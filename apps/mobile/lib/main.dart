import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'app.dart';

/// Entry point for the Supreme OS homeowner app. Local-first: it talks to the hub
/// over the Supreme API (LAN-direct, or via the optional cloud relay when away) —
/// the homeowner never configures a URL or sees any backend (HA) branding.
void main() {
  runApp(const ProviderScope(child: SupremeApp()));
}
