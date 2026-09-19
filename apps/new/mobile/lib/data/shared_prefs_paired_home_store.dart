import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Real, persisted `PairedHomeStore` (§Phase12.1 §21) — non-sensitive Home metadata only
/// (hubId/projectId/displayName/timestamps). Deliberately the SAME `shared_preferences`
/// mechanism `apps/new/touchpanel`'s `PrefsPanelConfigStore` already uses for its own
/// non-sensitive config cache — never used here for cryptographic material, which stays under
/// the existing `SecretBytesStore`/session-token architecture (Phase 11/12).
class SharedPrefsPairedHomeStore implements PairedHomeStore {
  static const _homesKey = 'supreme_paired_homes_v1';
  static const _activeHomeKey = 'supreme_active_home_id_v1';

  @override
  Future<List<PairedHome>> loadAll() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_homesKey);
    if (raw == null) return [];
    try {
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .map((e) => PairedHome.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      return [];
    }
  }

  @override
  Future<void> saveAll(List<PairedHome> homes) async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
        _homesKey, jsonEncode(homes.map((h) => h.toJson()).toList()));
  }

  @override
  Future<String?> loadActiveHomeId() async {
    final prefs = await SharedPreferences.getInstance();
    return prefs.getString(_activeHomeKey);
  }

  @override
  Future<void> saveActiveHomeId(String? hubId) async {
    final prefs = await SharedPreferences.getInstance();
    if (hubId == null) {
      await prefs.remove(_activeHomeKey);
    } else {
      await prefs.setString(_activeHomeKey, hubId);
    }
  }
}
