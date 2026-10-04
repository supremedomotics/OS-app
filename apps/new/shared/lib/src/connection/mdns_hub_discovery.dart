/// Real LAN discovery via mDNS/DNS-SD (§Phase9-4) — this is the actual
/// implementation, not a mock, browsing for [SupremeOSHubDefaults.mdnsServiceType]
/// (`_supremeos._tcp`) exactly as documented on that class.
///
/// PLATFORM NOTE: this file uses `package:multicast_dns`, which is built on
/// `dart:io` raw UDP sockets — that works on Android/iOS/desktop but NOT on
/// Flutter Web (no raw socket access in a browser). Deliberately NOT
/// exported from `supreme_os_core.dart`'s main barrel so that Mobile/Touch
/// Panel's web builds (the only target buildable in this sandbox — no
/// Android SDK/Xcode/Visual-Studio-C++ toolchain here, see the Phase 1-6
/// verification report) never transitively import `dart:io` through the
/// barrel. A real mobile/desktop build swaps `MockHubDiscovery` for
/// `MdnsHubDiscovery` at the composition root (one line) to use this.
///
/// HONEST STATUS: this code is real and complete against the
/// `multicast_dns` API, but it has never been run against an actual
/// SupremeOS Hub advertising `_supremeos._tcp` — no such advertiser exists
/// yet (§Phase9-2: the real Hub has no mDNS responder today). It cannot be
/// verified end-to-end until that Hub-side work lands. Treat this as
/// "implemented, integration-unverified," not "production proven."
library;

import 'dart:io';
import 'package:multicast_dns/multicast_dns.dart';

import 'hub_defaults.dart';
import 'transport.dart';

/// TXT record keys a Hub's mDNS advertisement is expected to carry
/// alongside the standard SRV (host/port) and PTR (service instance) data.
/// Documented here so a future Hub-side responder implementation has an
/// exact contract to match, not a guess.
class HubMdnsTxtKeys {
  const HubMdnsTxtKeys._();
  static const hubId = 'hubId';
  static const projectId = 'projectId';
  static const protocolVersion = 'version';

  /// Optional, additive (no `txtvers` bump): the Hub's homeowner-facing product name.
  static const name = 'name';
}

final _rawInstanceShape = RegExp(
    r'\._(tcp|udp)\b|\.local\b|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-',
    caseSensitive: false);

/// The name a homeowner sees for a discovered Hub. Only an advertised `name` that reads like a
/// name is used; anything absent, over-long, or shaped like a service instance / UUID (which is
/// what a Hub that predates the `name` key exposes) falls back to the product name — the raw
/// instance string is never homeowner copy.
String friendlyHubName(String? advertisedName) {
  final n = advertisedName?.trim() ?? '';
  if (n.isEmpty || n.length > 64 || _rawInstanceShape.hasMatch(n)) {
    return SupremeOSHubDefaults.friendlyHubName;
  }
  return n;
}

/// `key=value` lines of a TXT record (the `multicast_dns` package joins a record's strings with
/// `\n`). Unknown keys are kept; the caller ignores what it doesn't know.
Map<String, String> parseHubTxt(Iterable<String> texts) {
  final out = <String, String>{};
  for (final text in texts) {
    for (final line in text.split('\n')) {
      final eq = line.indexOf('=');
      if (eq > 0) out[line.substring(0, eq)] = line.substring(eq + 1);
    }
  }
  return out;
}

/// Builds the discovery result for one advertisement. Identity is the `hubId` TXT key; the
/// instance name is only a last-resort identifier when a Hub's TXT was lost (its first label —
/// for a Hub that predates the `name` key that label *is* the hubId) and is kept verbatim on
/// [DiscoveredHub.rawInstanceName] for diagnostics, never as the display name.
DiscoveredHub hubFromAdvertisement({
  required String instanceName,
  required String address,
  required int port,
  required Map<String, String> txt,
}) {
  final hubId = txt[HubMdnsTxtKeys.hubId] ?? instanceName.split('.').first;
  return DiscoveredHub(
    identity: HubIdentity(
      hubId: hubId,
      displayName: friendlyHubName(txt[HubMdnsTxtKeys.name]),
      projectId: txt[HubMdnsTxtKeys.projectId],
    ),
    address: address,
    port: port,
    protocolVersion: txt[HubMdnsTxtKeys.protocolVersion],
    rawInstanceName: instanceName,
  );
}

/// Two Hubs on one LAN both read "SupremeOS Hub"; a homeowner (and the identity-name picker) must
/// still tell them apart, so a name shared by distinct `hubId`s gets a short id suffix. Identity
/// comparison never looks at the name, so this is presentation only.
List<DiscoveredHub> disambiguateHubNames(List<DiscoveredHub> hubs) {
  final idsByName = <String, Set<String>>{};
  for (final h in hubs) {
    idsByName
        .putIfAbsent(h.identity.displayName, () => {})
        .add(h.identity.hubId);
  }
  return [
    for (final h in hubs)
      if (idsByName[h.identity.displayName]!.length < 2)
        h
      else
        DiscoveredHub(
          identity: HubIdentity(
            hubId: h.identity.hubId,
            displayName: _withShortId(h.identity),
            projectId: h.identity.projectId,
          ),
          address: h.address,
          port: h.port,
          protocolVersion: h.protocolVersion,
          available: h.available,
          lastSeen: h.lastSeen,
          rawInstanceName: h.rawInstanceName,
        ),
  ];
}

String _withShortId(HubIdentity id) {
  final short = id.hubId
      .replaceAll(RegExp(r'[^0-9a-zA-Z]'), '')
      .toUpperCase();
  return short.isEmpty
      ? id.displayName
      : '${id.displayName} (${short.substring(0, short.length < 6 ? short.length : 6)})';
}

class MdnsHubDiscovery implements HubDiscovery {
  const MdnsHubDiscovery();

  @override
  Future<Uri?> discoverLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    final hubs = await discoverAllLan(timeout: timeout);
    return hubs.isEmpty ? null : hubs.first.controlUri;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    final client = MDnsClient();
    final results = <DiscoveredHub>[];
    try {
      await client.start();

      await for (final ptr in client
          .lookup<PtrResourceRecord>(
            ResourceRecordQuery.serverPointer(
                SupremeOSHubDefaults.mdnsServiceType),
          )
          .timeout(timeout, onTimeout: (sink) => sink.close())) {
        String? host;
        int port = SupremeOSHubDefaults.defaultPort;
        await for (final srv in client
            .lookup<SrvResourceRecord>(
                ResourceRecordQuery.service(ptr.domainName))
            .timeout(const Duration(seconds: 1),
                onTimeout: (sink) => sink.close())) {
          host = srv.target;
          port = srv.port;
        }
        if (host == null) continue;

        String? address;
        await for (final ip in client
            .lookup<IPAddressResourceRecord>(
                ResourceRecordQuery.addressIPv4(host))
            .timeout(const Duration(seconds: 1),
                onTimeout: (sink) => sink.close())) {
          address = ip.address.address;
        }
        address ??= host;

        final texts = <String>[];
        await for (final txt in client
            .lookup<TxtResourceRecord>(ResourceRecordQuery.text(ptr.domainName))
            .timeout(const Duration(seconds: 1),
                onTimeout: (sink) => sink.close())) {
          texts.add(txt.text);
        }

        results.add(hubFromAdvertisement(
          instanceName: ptr.domainName,
          address: address,
          port: port,
          txt: parseHubTxt(texts),
        ));
      }
    } on SocketException {
      // No multicast-capable interface available (e.g. sandboxed/CI network) —
      // discovery simply finds nothing, matching the "Hub unreachable" path
      // ConnectionManager already handles; this is not a crash condition.
    } finally {
      client.stop();
    }
    return disambiguateHubNames(results);
  }
}
