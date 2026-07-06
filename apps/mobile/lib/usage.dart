import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'providers.dart';

/// Personalization (§ Personalization) — the app learns from real use, no configuration required.
/// Every scene activation or device action is recorded LOCALLY (this device only) so the dashboard
/// can surface what the homeowner actually uses: recently-used first. This is genuine observed usage
/// — never invented data — and it never leaves the device or touches the backend.
typedef Use = ({String kind, String id});

class UsageNotifier extends Notifier<List<String>> {
  static const _key = 'usage.log';
  static const _max = 200;

  @override
  List<String> build() => ref.watch(sharedPreferencesProvider).getStringList(_key) ?? const [];

  /// Record one interaction (kind is 'scene' or 'device'). Call at the moment the user acts.
  void record(String kind, String id) {
    final next = [...state, '$kind:$id'];
    final trimmed = next.length > _max ? next.sublist(next.length - _max) : next;
    state = trimmed;
    ref.read(sharedPreferencesProvider).setStringList(_key, trimmed);
  }

  /// Use-count for one item — a frequency signal for ordering (frequently-used first).
  int count(String kind, String id) {
    final key = '$kind:$id';
    return state.where((e) => e == key).length;
  }

  /// Most-recently-used distinct items (newest first).
  List<Use> recent([int limit = 6]) {
    final seen = <String>{};
    final out = <Use>[];
    for (var i = state.length - 1; i >= 0 && out.length < limit; i--) {
      final e = state[i];
      if (seen.contains(e)) continue;
      seen.add(e);
      final idx = e.indexOf(':');
      if (idx <= 0) continue;
      out.add((kind: e.substring(0, idx), id: e.substring(idx + 1)));
    }
    return out;
  }
}

final usageProvider = NotifierProvider<UsageNotifier, List<String>>(UsageNotifier.new);
