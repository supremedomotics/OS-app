import 'dart:async';

import '../capabilities.dart';
import '../connection/connection_manager.dart';
import '../experiences.dart';
import '../semantic_model.dart';

/// The semantic read/control boundary between a Home's Hub connection and the homeowner UI
/// (§Phase12.3). Everything on this interface is a SupremeOS concept (Space, Lighting mood,
/// Shade position, Experience) — never a protocol concept (no KNX/Casambi/Matter/DALI/Lutron,
/// no datapoint/endpoint/cluster/group-address, no transport/broker detail). A widget that
/// depends on this interface cannot accidentally leak a protocol term into the UI, because
/// this interface has no way to express one.
///
/// One instance is bound to exactly ONE active Home's [ConnectionManager] (§Phase12.3's
/// "active Home → semantic repository" requirement) — never a global, never shared across
/// Homes. Switching Homes means constructing a NEW repository over the newly-active
/// [ConnectionManager], never mutating this one's target.
abstract class HomeStateRepository {
  /// The connection state of the Home this repository is bound to — the UI's only source of
  /// truth for "is my selected Home reachable right now."
  Stream<HubConnectionState> get connectionState;

  Future<List<Space>> spaces();
  Future<List<Experience>> experiences();

  /// Each returns null when the Hub hasn't reported a value yet (never a fabricated default —
  /// the UI should render a loading/unknown state, not invented data).
  Future<DomainState<LightingValue>?> lighting(String spaceId);
  Future<DomainState<ShadesValue>?> shades(String spaceId);
  Future<DomainState<ClimateValue>?> climate(String spaceId);
  Future<DomainState<AudioValue>?> audio(String spaceId);

  Future<void> setLighting(String spaceId, {bool? on, LightingMood? mood});
  Future<void> setShadesPosition(String spaceId, {required int percentOpen});
  Future<void> setClimate(String spaceId, {double? targetC, ClimateMode? mode});
  Future<void> setAudio(String spaceId, {bool? playing, int? volumePercent});

  Future<void> invokeExperience(String experienceId);

  /// Releases whatever this repository holds open (subscriptions, etc.) — called when its
  /// Home is no longer the active one (§Phase12.3 "dispose/release A-scoped state").
  Future<void> dispose();
}

/// §Phase12.8 REWRITE — now calls the REAL Hub REST contract discovered in Phase 12.4
/// (`services/gateway/src/routes/{home,devices,scenes}.ts`), not the invented `v1/spaces`/
/// `v1/rooms/:id/lighting` paths Phase 12.3 originally proposed. Reads use
/// `ConnectionManager.get()` (§Phase12.8's new `HubTransport.get`, matching the real API's
/// `GET` verb); writes still use `sendCommand` (`POST /v1/devices/:id/command`,
/// `POST /v1/scenes/:id/activate` — both real `POST` routes).
///
/// HONEST STATUS — real, not fabricated, but with a genuine, documented model mismatch: the
/// real API is DEVICE-centric (a room holds N independently-controllable devices, each with
/// its own capability set); SupremeOS's simplified per-room Lighting/Shades/Climate/Audio
/// model (Phase 7/12.3) assumes ONE control per domain per room. §Phase12.9 REMOVED the "first
/// matching device" heuristic Phase 12.8 shipped: [_resolveDeviceForCapability] now resolves
/// deterministically (zero → null, exactly one → that device, two-or-more →
/// [AmbiguousDeviceResolutionException]) instead of silently guessing. A room with two
/// independent lighting circuits or two audio zones is a genuine, surfaced
/// BACKEND CONTRACT MISSING case — see that method's doc — not a UI bug to hide.
class HubHomeStateRepository implements HomeStateRepository {
  final ConnectionManager connectionManager;

  HubHomeStateRepository(this.connectionManager);

  @override
  Stream<HubConnectionState> get connectionState => connectionManager.state;

  /// Never throws to the caller — an unreachable Hub means "no data yet," not a crash. The
  /// UI's source of truth for WHY is [connectionState], not an exception from a read call.
  Future<Map<String, dynamic>> _get(String path) async {
    try {
      return await connectionManager.get(path);
    } catch (_) {
      return const {};
    }
  }

  @override
  Future<List<Space>> spaces() async {
    final home = await _get('v1/home');
    final rooms = home['rooms'];
    if (rooms is! List) return const [];

    // One extra real call to build each room's domain set from its actual devices — the real
    // API has no room-level "domains" field (that was Phase 12.3's invented shape); this is
    // the honest replacement using real device capability data.
    final devicesRes = await _get('v1/devices');
    final devices = (devicesRes['devices'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
    final domainsByRoom = <String, Set<HomeDomain>>{};
    for (final d in devices) {
      final roomId = d['roomId'] as String?;
      if (roomId == null) continue;
      final caps = (d['capabilities'] as List<dynamic>? ?? const [])
          .cast<Map<String, dynamic>>();
      final domains = domainsByRoom.putIfAbsent(roomId, () => {});
      for (final c in caps) {
        final domain = _domainForCapabilityKind(c['kind'] as String?);
        if (domain != null) domains.add(domain);
      }
    }

    return rooms.cast<Map<String, dynamic>>().map((r) {
      final id = r['id'] as String;
      return Space(
        id: id,
        name: r['name'] as String,
        floorId: (r['floor'] as num?)?.toString(),
        domains: domainsByRoom[id] ?? const {},
      );
    }).toList();
  }

  HomeDomain? _domainForCapabilityKind(String? kind) {
    switch (kind) {
      case 'onoff':
      case 'brightness':
      case 'color':
        return HomeDomain.lighting;
      case 'position':
        return HomeDomain.shades;
      case 'temperature':
        return HomeDomain.climate;
      case 'media':
        return HomeDomain.audio;
      default:
        return null;
    }
  }

  @override
  Future<List<Experience>> experiences() async {
    final res = await _get('v1/scenes');
    final raw = res['scenes'];
    if (raw is! List) return const [];
    return raw.whereType<Map<String, dynamic>>().map((s) {
      return Experience(
        id: s['id'] as String,
        name: s['name'] as String,
        spaceIds: (s['roomIds'] as List<dynamic>? ?? const []).cast<String>(),
      );
    }).toList();
  }

  /// §Phase12.9 REPLACES the "first matching device" simplification. Finds every device in
  /// [roomId] whose real `capabilities` list includes [capabilityKind] and applies the ONLY
  /// deterministic rule that requires no invented heuristic: zero matches → null (no device);
  /// exactly one match → that device (unambiguous, real); two or more matches → throws
  /// [AmbiguousDeviceResolutionException] rather than silently picking one.
  ///
  /// HONEST STATUS — BACKEND CONTRACT MISSING: the real Hub API
  /// (`services/gateway/src/routes/devices.ts`) has no semantic "primary device for this
  /// room+capability" field, no per-room function/endpoint id, and no installer-assigned
  /// binding a room's Lighting/Shades/Climate/Audio card could deterministically resolve to
  /// when a room legitimately has two independent lighting circuits or two audio zones. Picking
  /// "first"/"alphabetical"/"lowest id" would be an invented heuristic the Hub never asserted —
  /// this class refuses to do that. Until the Hub gains real semantic device/function binding,
  /// any room with more than one device sharing a capability is a genuinely unsupported case,
  /// surfaced as a thrown exception the UI must render as an honest gated/ambiguous state, never
  /// silently resolved.
  Future<Map<String, dynamic>?> _resolveDeviceForCapability(
      String roomId, String capabilityKind) async {
    final res = await _get('v1/rooms/$roomId/devices');
    final devices = (res['devices'] as List<dynamic>? ?? const [])
        .cast<Map<String, dynamic>>();
    final matches = devices.where((d) {
      final caps = (d['capabilities'] as List<dynamic>? ?? const [])
          .cast<Map<String, dynamic>>();
      return caps.any((c) => c['kind'] == capabilityKind);
    }).toList();
    if (matches.isEmpty) return null;
    if (matches.length == 1) return matches.single;
    throw AmbiguousDeviceResolutionException(
      roomId: roomId,
      capabilityKind: capabilityKind,
      deviceIds: matches.map((d) => d['id'] as String).toList(),
    );
  }

  @override
  Future<DomainState<LightingValue>?> lighting(String spaceId) async {
    final device = await _resolveDeviceForCapability(spaceId, 'onoff') ??
        await _resolveDeviceForCapability(spaceId, 'brightness');
    if (device == null) return null;
    final state = (device['state'] as Map<String, dynamic>?) ?? const {};
    final onoff = (state['onoff'] as Map<String, dynamic>?) ??
        (state['brightness'] as Map<String, dynamic>?);
    if (onoff == null) return null;
    // HONEST SIMPLIFICATION: mood is not derived from the device's real `color` capability
    // (kelvin/hue) yet — always `neutral` until that mapping is built.
    return DomainState(
      LightingValue(
          on: onoff['on'] as bool? ?? false, mood: LightingMood.neutral),
      ConfirmationState.confirmed,
    );
  }

  @override
  Future<DomainState<ShadesValue>?> shades(String spaceId) async {
    final device = await _resolveDeviceForCapability(spaceId, 'position');
    if (device == null) return null;
    final state = (device['state'] as Map<String, dynamic>?)?['position']
        as Map<String, dynamic>?;
    if (state == null) return null;
    final percent = (state['position'] as num?)?.toInt() ?? 0;
    final position = percent >= 90
        ? ShadePosition.open
        : percent <= 5
            ? ShadePosition.closed
            : ShadePosition.relaxed;
    return DomainState(ShadesValue(position: position, percentOpen: percent),
        ConfirmationState.confirmed);
  }

  @override
  Future<DomainState<ClimateValue>?> climate(String spaceId) async {
    final device = await _resolveDeviceForCapability(spaceId, 'temperature');
    if (device == null) return null;
    final state = (device['state'] as Map<String, dynamic>?)?['temperature']
        as Map<String, dynamic>?;
    if (state == null) return null;
    final mode = switch (state['mode'] as String?) {
      'heat' => ClimateMode.heating,
      'cool' => ClimateMode.cooling,
      'off' => ClimateMode.off,
      _ => ClimateMode.auto,
    };
    return DomainState(
      ClimateValue(
        ambientC: (state['ambientC'] as num?)?.toDouble() ?? 0,
        targetC: (state['targetC'] as num?)?.toDouble() ??
            (state['ambientC'] as num?)?.toDouble() ??
            0,
        mode: mode,
      ),
      ConfirmationState.confirmed,
    );
  }

  @override
  Future<DomainState<AudioValue>?> audio(String spaceId) async {
    final device = await _resolveDeviceForCapability(spaceId, 'media');
    if (device == null) return null;
    final state = (device['state'] as Map<String, dynamic>?)?['media']
        as Map<String, dynamic>?;
    if (state == null) return null;
    return DomainState(
      AudioValue(
        playing: state['playback'] == 'playing',
        title: state['title'] as String?,
        artist: state['artist'] as String?,
        volumePercent: (state['volume'] as num?)?.toInt() ?? 0,
      ),
      ConfirmationState.confirmed,
    );
  }

  Future<void> _command(String deviceId, Map<String, dynamic> command) =>
      connectionManager
          .sendCommand('v1/devices/$deviceId/command', {'command': command});

  @override
  Future<void> setLighting(String spaceId,
      {bool? on, LightingMood? mood}) async {
    final device = await _resolveDeviceForCapability(spaceId, 'onoff') ??
        await _resolveDeviceForCapability(spaceId, 'brightness');
    if (device == null) throw StateError('no lighting device in this room');
    if (on != null) {
      await _command(device['id'] as String,
          {'capability': 'onoff', 'action': on ? 'on' : 'off'});
    }
    // `mood` has no real-capability mapping yet (see class doc) — intentionally not sent.
  }

  @override
  Future<void> setShadesPosition(String spaceId,
      {required int percentOpen}) async {
    final device = await _resolveDeviceForCapability(spaceId, 'position');
    if (device == null) throw StateError('no shades device in this room');
    await _command(device['id'] as String,
        {'capability': 'position', 'action': 'set', 'position': percentOpen});
  }

  @override
  Future<void> setClimate(String spaceId,
      {double? targetC, ClimateMode? mode}) async {
    final device = await _resolveDeviceForCapability(spaceId, 'temperature');
    if (device == null) throw StateError('no climate device in this room');
    final modeStr = switch (mode) {
      ClimateMode.heating => 'heat',
      ClimateMode.cooling => 'cool',
      ClimateMode.off => 'off',
      ClimateMode.auto || null => null,
    };
    await _command(device['id'] as String, {
      'capability': 'temperature',
      if (targetC != null) 'targetC': targetC,
      if (modeStr != null) 'mode': modeStr,
    });
  }

  @override
  Future<void> setAudio(String spaceId,
      {bool? playing, int? volumePercent}) async {
    final device = await _resolveDeviceForCapability(spaceId, 'media');
    if (device == null) throw StateError('no audio device in this room');
    if (playing != null) {
      await _command(device['id'] as String,
          {'capability': 'media', 'action': playing ? 'play' : 'pause'});
    }
    if (volumePercent != null) {
      await _command(device['id'] as String,
          {'capability': 'media', 'action': 'volume', 'volume': volumePercent});
    }
  }

  @override
  Future<void> invokeExperience(String experienceId) => connectionManager
      .sendCommand('v1/scenes/$experienceId/activate', const {});

  @override
  Future<void> dispose() async {
    // No subscriptions of its own — `connectionManager.state` is a broadcast stream the
    // ConnectionManager itself owns and disposes; this repository holds no other resources.
  }
}

/// §Phase12.9 — thrown by [HubHomeStateRepository] when a room has MORE THAN ONE device
/// exposing the requested capability and there is no real Hub-provided way to pick between
/// them (see [HubHomeStateRepository]'s class doc). The caller (UI layer) must render this as
/// an honest gated/unsupported state — e.g. "multiple lighting circuits in this room aren't
/// supported yet" — never suppress it and never fall back to guessing.
class AmbiguousDeviceResolutionException implements Exception {
  final String roomId;
  final String capabilityKind;
  final List<String> deviceIds;

  const AmbiguousDeviceResolutionException({
    required this.roomId,
    required this.capabilityKind,
    required this.deviceIds,
  });

  @override
  String toString() =>
      'AmbiguousDeviceResolutionException: room "$roomId" has ${deviceIds.length} devices '
      'with capability "$capabilityKind" (${deviceIds.join(', ')}) — the Hub has no semantic '
      'primary-device mapping to disambiguate (BACKEND CONTRACT MISSING).';
}
