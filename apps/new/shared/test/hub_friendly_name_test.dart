// ignore_for_file: implementation_imports
import 'package:supreme_os_core/src/connection/mdns_hub_discovery.dart';
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// Homeowner-facing Hub name vs. Hub identity. A discovered Hub's raw DNS-SD instance string
/// (`<id>._supremeos._tcp.local`) is diagnostics data: it must never be the display name and never
/// the identity, while `hubId` (from the TXT record) stays the one thing everything keys on.

const _uuid = '01a0c8d9-bbcc-732c-b074-b0633f21e73e';
const _legacyInstance = '$_uuid._supremeos._tcp.local';

DiscoveredHub _legacyHub({String address = '192.168.0.20'}) =>
    hubFromAdvertisement(
      instanceName: _legacyInstance,
      address: address,
      port: 7272,
      txt: parseHubTxt(['hubId=$_uuid\nversion=1.2.3\ntxtvers=1']),
    );

void main() {
  group('friendlyHubName', () {
    test('the product name when nothing (or nothing name-like) is advertised',
        () {
      expect(friendlyHubName(null), 'SupremeOS Hub');
      expect(friendlyHubName(''), 'SupremeOS Hub');
      expect(friendlyHubName('   '), 'SupremeOS Hub');
      expect(friendlyHubName(_legacyInstance), 'SupremeOS Hub');
      expect(friendlyHubName(_uuid), 'SupremeOS Hub');
      expect(friendlyHubName('hub.local'), 'SupremeOS Hub');
      expect(friendlyHubName('x' * 65), 'SupremeOS Hub');
    });

    test('an advertised name that reads like a name is used', () {
      expect(friendlyHubName('SupremeOS Hub'), 'SupremeOS Hub');
      expect(friendlyHubName('  Boat House Hub '), 'Boat House Hub');
    });

    test('the constant matches the Hub defaults', () {
      expect(SupremeOSHubDefaults.friendlyHubName, 'SupremeOS Hub');
      expect(SupremeOSHubDefaults.mdnsServiceType, '_supremeos._tcp');
    });
  });

  group('discovery returns a homeowner-friendly Hub', () {
    test('a Hub that predates the name key (UUID instance) is shown as "SupremeOS Hub"',
        () {
      final hub = _legacyHub();
      expect(hub.identity.displayName, 'SupremeOS Hub');
      expect(hub.identity.displayName, isNot(contains(_uuid)));
      expect(hub.identity.displayName, isNot(contains('_supremeos')));
      expect(hub.identity.displayName, isNot(contains('.local')));
    });

    test('a current Hub advertising name=SupremeOS Hub is shown as that', () {
      final hub = hubFromAdvertisement(
        instanceName: 'SupremeOS Hub (01A0C8)._supremeos._tcp.local',
        address: '192.168.0.20',
        port: 7272,
        txt: parseHubTxt(['hubId=$_uuid\nname=SupremeOS Hub\nversion=1.2.3']),
      );
      expect(hub.identity.displayName, 'SupremeOS Hub');
      expect(hub.identity.hubId, _uuid);
    });

    test('the stable hubId comes from the TXT record and is unchanged by the name',
        () {
      final hub = _legacyHub();
      expect(hub.identity.hubId, _uuid);
      expect(hub.protocolVersion, '1.2.3');
      expect(hub.controlUri.toString(), 'http://192.168.0.20:7272');
    });

    test('the raw instance string is kept for diagnostics only', () {
      expect(_legacyHub().rawInstanceName, _legacyInstance);
      expect(
          const MockHubDiscovery().discoverAllLan().then((h) => h.single.rawInstanceName),
          completion(isNull));
    });

    test('with the TXT lost, the instance LABEL (never the FQDN) is the last-resort id, still not the name',
        () {
      final hub = hubFromAdvertisement(
          instanceName: _legacyInstance,
          address: '192.168.0.20',
          port: 7272,
          txt: const {});
      expect(hub.identity.hubId, _uuid);
      expect(hub.identity.displayName, 'SupremeOS Hub');
    });

    test('TXT parsing tolerates unknown keys, empty values and junk lines', () {
      final txt = parseHubTxt(['hubId=abc\nfuture=1\nnovalue\nempty=\n=bad']);
      expect(txt['hubId'], 'abc');
      expect(txt['future'], '1');
      expect(txt['empty'], '');
      expect(txt.containsKey('novalue'), isFalse);
    });
  });

  group('simulator / mock discovery follows the same contract', () {
    test('MockHubDiscovery names its Hub with the same friendly name', () async {
      final hubs = await const MockHubDiscovery().discoverAllLan();
      expect(hubs.single.identity.displayName,
          SupremeOSHubDefaults.friendlyHubName);
      expect(hubs.single.identity.displayName, friendlyHubName(null));
      expect(hubs.single.controlUri.scheme, 'http');
    });
  });

  group('several Hubs on one LAN never collide', () {
    DiscoveredHub hub(String id, String address) => hubFromAdvertisement(
        instanceName: '$id._supremeos._tcp.local',
        address: address,
        port: 7272,
        txt: parseHubTxt(['hubId=$id']));

    test('distinct Hubs sharing the name are told apart by a short id; identities stay distinct',
        () {
      final out = disambiguateHubNames([
        hub('01a0c8d9-bbcc-732c', '192.168.0.20'),
        hub('77ff0011-aaaa-4bcd', '192.168.0.21'),
      ]);
      expect(out.map((h) => h.identity.displayName),
          ['SupremeOS Hub (01A0C8)', 'SupremeOS Hub (77FF00)']);
      expect(out[0].identity, isNot(equals(out[1].identity)));
      expect(out.map((h) => h.identity.hubId),
          ['01a0c8d9-bbcc-732c', '77ff0011-aaaa-4bcd']);
      expect(out.map((h) => h.address), ['192.168.0.20', '192.168.0.21']);
      expect(out.every((h) => h.rawInstanceName != null), isTrue);
    });

    test('one Hub answering twice (two interfaces) is still just "SupremeOS Hub"',
        () {
      final out = disambiguateHubNames([
        hub('01a0c8d9', '192.168.0.20'),
        hub('01a0c8d9', '10.0.0.5'),
      ]);
      expect(out.map((h) => h.identity.displayName),
          ['SupremeOS Hub', 'SupremeOS Hub']);
    });

    test('a lone Hub is left untouched', () {
      final one = hub('01a0c8d9', '192.168.0.20');
      expect(disambiguateHubNames([one]).single, same(one));
    });

    test('SingleHubDiscovery still resolves exactly one Hub by hubId, whatever the names say',
        () async {
      final all = disambiguateHubNames([
        hub('01a0c8d9-bbcc-732c', '192.168.0.20'),
        hub('77ff0011-aaaa-4bcd', '192.168.0.21'),
      ]);
      final scoped = SingleHubDiscovery(_Fixed(all), '77ff0011-aaaa-4bcd');
      final found = await scoped.discoverAllLan();
      expect(found.single.address, '192.168.0.21');
      expect((await scoped.discoverLan()).toString(), 'http://192.168.0.21:7272');
    });
  });
}

class _Fixed implements HubDiscovery {
  final List<DiscoveredHub> hubs;
  const _Fixed(this.hubs);
  @override
  Future<Uri?> discoverLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs.isEmpty ? null : hubs.first.controlUri;
  @override
  Future<List<DiscoveredHub>> discoverAllLan(
          {Duration timeout = const Duration(seconds: 3)}) async =>
      hubs;
}
