import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// A Hub the person told us the address of, because LAN discovery did not find it (the original's
/// "or connect manually" on its Hub-not-found screen). [hubId] is learned when the Hub is paired
/// (the authorization names it), so reconnecting later resolves the Home by identity, never by the
/// address the person typed.
class ManualHub {
  final String host;
  final int port;
  final String? hubId;
  const ManualHub(this.host, this.port, [this.hubId]);

  Map<String, Object?> toJson() => {'host': host, 'port': port, 'hubId': hubId};
  static ManualHub? fromJson(Object? j) {
    if (j is! Map) return null;
    final h = j['host'], p = j['port'];
    return h is String && p is int ? ManualHub(h, p, j['hubId'] as String?) : null;
  }
}

/// Manually entered Hub addresses (not secrets: an address on the person's own network). Kept in
/// `shared_preferences`, like the paired-Home metadata.
class ManualHubStore {
  static const _key = 'supremeos_manual_hubs_v1';

  Future<List<ManualHub>> load() async {
    try {
      final raw = (await SharedPreferences.getInstance()).getString(_key);
      if (raw == null) return const [];
      return [
        for (final e in (jsonDecode(raw) as List)) if (ManualHub.fromJson(e) != null) ManualHub.fromJson(e)!
      ];
    } catch (_) {
      return const [];
    }
  }

  Future<void> _save(List<ManualHub> hubs) async => (await SharedPreferences.getInstance())
      .setString(_key, jsonEncode([for (final h in hubs) h.toJson()]));

  Future<void> add(String host, int port) async {
    final all = await load();
    if (all.any((h) => h.host == host && h.port == port)) return;
    await _save([...all, ManualHub(host, port)]);
  }

  /// Pairing named the Hub at [host]:[port]: remember its identity.
  Future<void> bindHubId(String host, int port, String hubId) async {
    final all = await load();
    await _save([
      for (final h in all)
        if (h.host == host && h.port == port) ManualHub(host, port, hubId) else h
    ]);
  }
}

/// Is a SupremeOS Hub answering at [host]:[port]? Its plain-HTTP direct channel serves `/healthz`.
Future<bool> probeHub(String host, int port, {http.Client? client}) async {
  final c = client ?? http.Client();
  try {
    final r = await c.get(Uri.http('$host:$port', '/healthz')).timeout(const Duration(seconds: 4));
    return r.statusCode == 200;
  } on TimeoutException {
    return false;
  } catch (_) {
    return false;
  } finally {
    if (client == null) c.close();
  }
}

/// LAN discovery plus the Hubs the person typed in. A manual Hub counts only while it answers, so
/// "not found" stays honest; one already found by mDNS (same address) is not listed twice.
class ManualAwareDiscovery implements HubDiscovery {
  final HubDiscovery inner;
  final ManualHubStore store;
  final Future<bool> Function(String host, int port) probe;
  const ManualAwareDiscovery(
      {required this.inner, required this.store, this.probe = probeHub});

  @override
  Future<Uri?> discoverLan({Duration timeout = const Duration(seconds: 3)}) async {
    final all = await discoverAllLan(timeout: timeout);
    return all.isEmpty ? null : all.first.controlUri;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    final found = await inner.discoverAllLan(timeout: timeout);
    final saved = await store.load();
    final extra = await Future.wait([
      for (final m in saved)
        if (!found.any((h) => h.address == m.host))
          probe(m.host, m.port).then((ok) => ok
              ? DiscoveredHub(
                  identity: HubIdentity(
                      hubId: m.hubId ?? 'manual:${m.host}',
                      displayName: SupremeOSHubDefaults.friendlyHubName),
                  address: m.host,
                  port: m.port)
              : null)
    ]);
    return [...found, ...extra.whereType<DiscoveredHub>()];
  }
}

// ── the original's validation of the manual form (RULES 'h-ip' / 'h-port'), word for word ──

/// `null` when valid.
String? validateHubIp(String raw) {
  final v = raw.trim();
  if (v.isEmpty) return 'Please enter your residence’s IP address.';
  final m = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$').firstMatch(v);
  if (m == null || [1, 2, 3, 4].map((i) => m.group(i)!).any((o) => int.parse(o) > 255 || (o.length > 1 && o[0] == '0'))) {
    return 'Use four numbers from 0 to 255, e.g. 192.168.1.20.';
  }
  if (m.group(4) == '0' || m.group(4) == '255') {
    return 'That’s a network address, not a device. Check the last number.';
  }
  return null;
}

String? validateHubPort(String raw) {
  final v = raw.trim();
  final n = RegExp(r'^\d{1,5}$').hasMatch(v) ? int.parse(v) : 0;
  return n >= 1 && n <= 65535 ? null : 'Use a port number from 1 to 65535.';
}
