/// What the residence is made of — the Devices inventory (Golden Master `devices.js`, § A5): the
/// physical objects, seen as **In use now**, **Needs attention**, and then by function → floor →
/// room → device. Derived entirely from the Residence State; nothing is stored or invented.
///
/// Capability-driven, never protocol-driven: a device's function is decided by the capabilities it
/// DECLARES, through the very same derivations Control uses (`RoomLights`, `RoomShades`,
/// `RoomClimate`, `RoomMusic`), so the inventory, the Control layer and the device sheet can never
/// disagree about what a device is. A device none of those describe is "Other" and offers no
/// controls — it is listed, with what the Hub reports (reachability), and nothing more.
///
/// "Needs attention" is reachability only: it is the one health fact the contract carries. No
/// battery, firmware or fault list exists to show (see the contract gate), so none is drawn.
library;

import '../semantic_model.dart' show Space;
import 'command_tracker.dart';
import 'residence_description.dart';
import 'residence_state.dart';
import 'room_controls.dart';

enum DeviceFunction { lighting, shades, climate, media, other }

extension DeviceFunctionWords on DeviceFunction {
  /// Plural, for a heading: "Lighting", "Shades", "Climate", "Media", "Other".
  String get heading => switch (this) {
        DeviceFunction.lighting => 'Lighting',
        DeviceFunction.shades => 'Shades',
        DeviceFunction.climate => 'Climate',
        DeviceFunction.media => 'Media',
        DeviceFunction.other => 'Other',
      };

  /// The SupremeGlyph concept (light · aperture · atmosphere · resonance · object).
  String get glyph => switch (this) {
        DeviceFunction.lighting => 'light',
        DeviceFunction.shades => 'aperture',
        DeviceFunction.climate => 'atmosphere',
        DeviceFunction.media => 'resonance',
        DeviceFunction.other => 'object',
      };
}

/// What a device is, from what it declares. The same test Control applies to the same device.
DeviceFunction functionOf(DeviceRecord d) {
  if (RoomLights.of([d], const []) != null) return DeviceFunction.lighting;
  if (RoomShades.of([d], const []) != null) return DeviceFunction.shades;
  if (RoomClimate.allOf([d], const []).isNotEmpty) return DeviceFunction.climate;
  if (RoomMusic.allOf([d], const []).isNotEmpty) return DeviceFunction.media;
  return DeviceFunction.other;
}

/// One device, said in words from what it reports — never from a request that has not landed.
String deviceStateSentence(DeviceRecord d, [Iterable<CommandRecord> inFlight = const []]) {
  if (!d.isOnline) return 'Not responding';
  switch (functionOf(d)) {
    case DeviceFunction.lighting:
      final l = RoomLights.of([d], inFlight)!;
      if (l.onCount == 0) return 'Off';
      return l.dimmable && l.level != null ? 'On · ${l.level}%' : 'On';
    case DeviceFunction.shades:
      final s = RoomShades.of([d], inFlight)!;
      final p = s.position;
      if (p == null) return 'Not responding';
      if (s.moving) return 'Moving';
      return p >= 95 ? 'Open' : p <= 5 ? 'Closed' : '$p% open';
    case DeviceFunction.climate:
      final z = RoomClimate.allOf([d], inFlight).first;
      final a = z.ambientC;
      // `fmtTemp` carries the degree sign.
      if (!z.on) return a == null ? 'Off' : 'Off · ${fmtTemp(a)}';
      if (a == null) return z.targetC == null ? 'On' : 'Set to ${fmtTemp(z.targetC!)}';
      return z.targetC == null
          ? fmtTemp(a)
          : '${fmtTemp(a)} · set to ${fmtTemp(z.targetC!)}';
    case DeviceFunction.media:
      final m = RoomMusic.allOf([d], inFlight).first;
      if (m.playing) {
        final t = m.title;
        return t == null ? 'Playing' : m.artist == null ? 'Playing · $t' : 'Playing · $t · ${m.artist}';
      }
      return 'Quiet';
    case DeviceFunction.other:
      return 'Responding';
  }
}

/// When a device last reported, in words — null when the residence does not know (a device that
/// has only ever been read from a snapshot has no observed time, and none is invented).
String? reportedWords(DateTime? at, DateTime now) {
  if (at == null) return null;
  final d = now.difference(at);
  if (d.inSeconds < 45) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes < 2 ? 1 : d.inMinutes} min ago';
  if (d.inHours < 24) return '${d.inHours} h ago';
  return '${d.inDays} d ago';
}

/// Doing something right now: a light on, music playing, a shade travelling, climate running.
bool deviceInUse(DeviceRecord d) {
  if (!d.isOnline) return false;
  switch (functionOf(d)) {
    case DeviceFunction.lighting:
      return RoomLights.of([d], const [])!.onCount > 0;
    case DeviceFunction.shades:
      return RoomShades.of([d], const [])!.moving;
    case DeviceFunction.climate:
      return RoomClimate.allOf([d], const []).first.on;
    case DeviceFunction.media:
      return RoomMusic.allOf([d], const []).first.playing;
    case DeviceFunction.other:
      return false;
  }
}

class DeviceEntry {
  final DeviceRecord device;
  final DeviceFunction function;

  /// The space's name, when the device is placed in one the residence knows.
  final String? spaceName;
  final String sentence;
  final bool inUse;
  bool get needsAttention => !device.isOnline;

  const DeviceEntry(
      this.device, this.function, this.spaceName, this.sentence, this.inUse);
}

class RoomDevices {
  final Space? space;
  final List<DeviceEntry> devices;
  const RoomDevices(this.space, this.devices);
}

class FloorDevices {
  /// Null = devices in spaces with no floor (or in no space); listed last, under no heading.
  final String? floorId;
  final List<RoomDevices> rooms;
  const FloorDevices(this.floorId, this.rooms);
  String? get label => floorId == null ? null : floorLabel(floorId);
}

class FunctionDevices {
  final DeviceFunction function;
  final List<FloorDevices> floors;
  const FunctionDevices(this.function, this.floors);
  int get count => [
        for (final f in floors)
          for (final r in f.rooms) ...r.devices
      ].length;
}

class DeviceInventory {
  final List<DeviceEntry> inUse;
  final List<DeviceEntry> attention;
  final List<FunctionDevices> madeOf;
  final int total;
  const DeviceInventory(this.inUse, this.attention, this.madeOf, this.total);
}

int _floorOrder(String? a, String? b) {
  if (a == b) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  return (int.tryParse(a) ?? 0).compareTo(int.tryParse(b) ?? 0);
}

/// The inventory of [s]: the whole residence, or only [spaceId]'s devices. Devices keep the Hub's
/// order within a room; functions appear in a fixed, familiar order and only when populated.
DeviceInventory inventoryOf(
  ResidenceSnapshot s, {
  Iterable<CommandRecord> inFlight = const [],
  String? spaceId,
}) {
  final devices = spaceId == null ? s.devices.values.toList() : s.devicesIn(spaceId);
  final entries = [
    for (final d in devices)
      DeviceEntry(
        d,
        functionOf(d),
        d.roomId == null ? null : s.space(d.roomId!)?.name,
        deviceStateSentence(d, inFlight),
        deviceInUse(d),
      )
  ];

  final madeOf = <FunctionDevices>[];
  for (final fn in DeviceFunction.values) {
    final mine = entries.where((e) => e.function == fn).toList();
    if (mine.isEmpty) continue;
    final byFloor = <String?, Map<String?, List<DeviceEntry>>>{};
    for (final e in mine) {
      final space = e.device.roomId == null ? null : s.space(e.device.roomId!);
      byFloor
          .putIfAbsent(space?.floorId, () => {})
          .putIfAbsent(space?.id, () => [])
          .add(e);
    }
    final floors = byFloor.keys.toList()..sort(_floorOrder);
    madeOf.add(FunctionDevices(fn, [
      for (final f in floors)
        FloorDevices(f, [
          // Rooms in the Hub's order; devices that belong to no known space last.
          for (final sp in s.spaces)
            if (byFloor[f]!.containsKey(sp.id)) RoomDevices(sp, byFloor[f]![sp.id]!),
          if (byFloor[f]!.containsKey(null)) RoomDevices(null, byFloor[f]![null]!),
        ]),
    ]));
  }

  return DeviceInventory(
    [for (final e in entries) if (e.inUse) e],
    [for (final e in entries) if (e.needsAttention) e],
    madeOf,
    entries.length,
  );
}
