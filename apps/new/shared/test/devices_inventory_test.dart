import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

import 'support/residence_rig.dart';

DeviceRecord _dev(String id, Map<String, Map<String, dynamic>> caps, Map<String, Map<String, dynamic>> state,
        {String type = 'other', String? room = 'x', DeviceReachability reach = DeviceReachability.online}) =>
    DeviceRecord(
        id: id, roomId: room, name: id, supremeType: type, reachability: reach,
        capabilities: caps, state: state);

void main() {
  test('what a device is comes from what it declares — the same test Control applies', () async {
    final r = Rig();
    await r.start();
    DeviceFunction f(String id) => functionOf(r.snap.devices[id]!);
    expect(f('living-light'), DeviceFunction.lighting);
    expect(f('terrace-light'), DeviceFunction.lighting, reason: 'a plain on/off light is a light');
    expect(f('living-shade'), DeviceFunction.shades);
    expect(f('living-climate'), DeviceFunction.climate);
    expect(f('living-audio'), DeviceFunction.media);
    // On/off with no light type is NOT assumed to be a light: it is listed as Other, without controls.
    final plug = _dev('plug', {'onoff': {}}, {'onoff': {'kind': 'onoff', 'on': true}}, type: 'switch');
    expect(functionOf(plug), DeviceFunction.other);
  });

  test('each device is said in words from what it reports', () async {
    final r = Rig();
    await r.start();
    String s(String id) => deviceStateSentence(r.snap.devices[id]!);
    expect(s('living-light'), 'On · 60%');
    expect(s('kitchen-light'), 'Off');
    expect(s('terrace-light'), 'Off');
    expect(s('living-shade'), 'Open');
    expect(s('master-shade'), 'Closed');
    expect(s('living-climate'), '22.5° · set to 22.0°');
    expect(s('living-audio'), 'Playing · Clair de Lune · Debussy');
    expect(s('terrace-audio'), 'Quiet');
  });

  test('in use now: what is doing something; an unreachable device is not "in use"', () async {
    final r = Rig();
    r.sim.setReachability('living-audio', 'offline');
    await r.start();
    final inv = inventoryOf(r.snap);
    expect(inv.inUse.map((e) => e.device.id).toSet(),
        {'living-light', 'dining-light', 'living-climate', 'master-climate'});
    expect(inv.attention.map((e) => e.device.id), ['living-audio']);
    expect(inv.attention.single.sentence, 'Not responding');
  });

  test('a shade in travel is in use and said to be moving', () async {
    final r = Rig(shadeStep: const Duration(seconds: 2));
    await r.start();
    r.tracker.submit('living-shade', {'capability': 'position', 'action': 'close'});
    await r.advance(3000);
    final e = inventoryOf(r.snap).inUse.firstWhere((e) => e.device.id == 'living-shade');
    expect(e.sentence, 'Moving');
  });

  test('made of: function → floor → room → device, populated groups only, Hub order', () async {
    final r = Rig();
    await r.start();
    final inv = inventoryOf(r.snap);
    expect(inv.total, r.snap.devices.length);
    expect(inv.madeOf.map((g) => g.function),
        [DeviceFunction.lighting, DeviceFunction.shades, DeviceFunction.climate, DeviceFunction.media],
        reason: 'no Other group: every simulated device is described by a function');
    final lighting = inv.madeOf.first;
    expect(lighting.floors.map((f) => f.label), ['Ground floor', 'First floor']);
    expect([for (final rm in lighting.floors.first.rooms) rm.space!.name],
        ['Living Room', 'Dining Room', 'Kitchen', 'Terrace']);
    expect(lighting.floors.last.rooms.single.devices.single.device.id, 'master-light');
    expect(lighting.count, 5);
  });

  test('scoped to a space: only that space, still grouped by function', () async {
    final r = Rig();
    await r.start();
    final inv = inventoryOf(r.snap, spaceId: 'living');
    expect(inv.total, 4);
    expect(inv.madeOf.map((g) => g.function),
        [DeviceFunction.lighting, DeviceFunction.shades, DeviceFunction.climate, DeviceFunction.media]);
    expect(inv.inUse.map((e) => e.device.id).toSet(), {'living-light', 'living-climate', 'living-audio'});
  });

  test('a device in no known space is listed last, without a floor heading', () {
    final lamp = _dev('lamp', {'onoff': {}}, {'onoff': {'kind': 'onoff', 'on': false}},
        type: 'light', room: null);
    final placed = _dev('desk', {'onoff': {}}, {'onoff': {'kind': 'onoff', 'on': true}}, type: 'light');
    final snap = ResidenceSnapshot(
        loaded: true, spaces: const [Space(id: 'x', name: 'Study', floorId: '0')],
        devices: {'lamp': lamp, 'desk': placed});
    final g = inventoryOf(snap).madeOf.single;
    expect(g.floors.map((f) => f.label), ['Ground floor', null]);
    expect(g.floors.last.rooms.single.space, isNull);
    expect(g.floors.last.rooms.single.devices.single.spaceName, isNull);
  });

  test('other devices are listed with what the Hub reports and nothing more', () {
    final plug = _dev('plug', {'onoff': {}}, {'onoff': {'kind': 'onoff', 'on': true}}, type: 'switch');
    final snap = ResidenceSnapshot(
        loaded: true, spaces: const [Space(id: 'x', name: 'Study')], devices: {'plug': plug});
    final inv = inventoryOf(snap);
    expect(inv.madeOf.single.function, DeviceFunction.other);
    expect(inv.madeOf.single.floors.single.label, isNull);
    expect(inv.inUse, isEmpty, reason: 'nothing states that an outlet is "in use"');
    expect(inv.madeOf.single.floors.single.rooms.single.devices.single.sentence, 'Responding');
  });

  test('when a device last reported is said in words, and unknown is never invented', () {
    final now = DateTime.utc(2026, 1, 1, 12);
    expect(reportedWords(null, now), isNull);
    expect(reportedWords(now.subtract(const Duration(seconds: 10)), now), 'just now');
    expect(reportedWords(now.subtract(const Duration(seconds: 100)), now), '1 min ago');
    expect(reportedWords(now.subtract(const Duration(minutes: 12)), now), '12 min ago');
    expect(reportedWords(now.subtract(const Duration(hours: 5)), now), '5 h ago');
    expect(reportedWords(now.subtract(const Duration(days: 3)), now), '3 d ago');
    expect(reportedWords(now.add(const Duration(seconds: 5)), now), 'just now',
        reason: 'a device clock slightly ahead of ours is not "in the future"');
  });

  test('an in-flight command does not change what a device is SAID to be doing', () async {
    final r = Rig();
    r.sim.setSilent('living-light', true);
    await r.start();
    r.tracker.submit('living-light', {'capability': 'brightness', 'action': 'off'});
    await r.advance(50);
    final e = inventoryOf(r.snap, inFlight: r.tracker.inFlight)
        .inUse
        .firstWhere((e) => e.device.id == 'living-light');
    expect(e.sentence, 'On · 60%', reason: 'still what the device reports');
  });
}
