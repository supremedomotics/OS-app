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

        var hubId = ptr.domainName;
        String? projectId;
        String? protocolVersion;
        await for (final txt in client
            .lookup<TxtResourceRecord>(ResourceRecordQuery.text(ptr.domainName))
            .timeout(const Duration(seconds: 1),
                onTimeout: (sink) => sink.close())) {
          for (final line in txt.text.split('\n')) {
            final eq = line.indexOf('=');
            if (eq < 0) continue;
            final key = line.substring(0, eq);
            final value = line.substring(eq + 1);
            if (key == HubMdnsTxtKeys.hubId) hubId = value;
            if (key == HubMdnsTxtKeys.projectId) projectId = value;
            if (key == HubMdnsTxtKeys.protocolVersion) protocolVersion = value;
          }
        }

        results.add(DiscoveredHub(
          identity: HubIdentity(
              hubId: hubId, displayName: ptr.domainName, projectId: projectId),
          address: address,
          port: port,
          protocolVersion: protocolVersion,
        ));
      }
    } on SocketException {
      // No multicast-capable interface available (e.g. sandboxed/CI network) —
      // discovery simply finds nothing, matching the "Hub unreachable" path
      // ConnectionManager already handles; this is not a crash condition.
    } finally {
      client.stop();
    }
    return results;
  }
}
