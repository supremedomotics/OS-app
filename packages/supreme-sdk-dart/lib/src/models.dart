/// Supreme domain models (Dart mirror of @supreme/domain-model). Kept minimal for
/// Phase 0; the full set is generated from `supreme-contracts` in Phase 1.

class Room {
  Room(
      {required this.id,
      required this.name,
      required this.areaType,
      this.building,
      this.floor = 0,
      this.area,
      this.heroImageUrl});

  final String id;
  final String name;
  final String areaType;

  /// Location hierarchy (§ Unified Onboarding): Building › Floor › Room › Area. [building] and
  /// [area] are optional free-text labels the UI groups by; [floor] is the numeric storey.
  final String? building;
  final int floor;
  final String? area;
  final String? heroImageUrl;

  factory Room.fromJson(Map<String, dynamic> json) => Room(
        id: json['id'] as String,
        name: json['name'] as String,
        areaType: json['areaType'] as String? ?? 'other',
        building: json['building'] as String?,
        floor: (json['floor'] as num?)?.toInt() ?? 0,
        area: json['area'] as String?,
        heroImageUrl: json['heroImageUrl'] as String?,
      );
}

class Device {
  Device({
    required this.id,
    required this.name,
    required this.supremeType,
    required this.roomId,
    required this.capabilities,
    required this.state,
    this.capabilityConfig = const {},
    this.manufacturer,
    this.model,
    this.driverId,
    this.status = 'online',
    this.metadata = const {},
  });

  final String id;
  final String name;
  final String supremeType;
  final String? roomId;
  final List<String> capabilities;

  /// Per-capability config keyed by capability kind (e.g. `media`'s
  /// AudioCapabilityConfig: inputs/soundModes/toneControl/zones/transport). Free-form —
  /// each capability defines its own shape; see the matching TS type in
  /// @supreme/protocols for the media capability.
  final Map<String, Map<String, dynamic>> capabilityConfig;

  /// Real device metadata (§ Device Manager). Nullable — a device may not declare a make/model or
  /// be bound to a driver. `status` is the platform's online/offline/unavailable enum.
  final String? manufacturer;
  final String? model;
  final String? driverId;
  final String status;

  /// Opaque device metadata (e.g. `network: {ip, mac, host}` captured at discovery).
  final Map<String, dynamic> metadata;

  /// Real network coordinates captured at discovery, or null for non-IP-bus devices.
  ({String? ip, String? mac, String? host})? get network {
    final n = metadata['network'];
    if (n is! Map) return null;
    return (ip: n['ip'] as String?, mac: n['mac'] as String?, host: n['host'] as String?);
  }

  /// Latest normalized state keyed by capability kind.
  final Map<String, dynamic> state;

  /// Convenience: brightness fill fraction 0..1 if the device is a dimmer.
  double get brightnessFraction {
    final b = state['brightness'] as Map<String, dynamic>?;
    if (b == null) return 0;
    return ((b['level'] as num?)?.toDouble() ?? 0) / 100.0;
  }

  bool get isOn {
    final b = state['brightness'] as Map<String, dynamic>?;
    if (b != null) return b['on'] as bool? ?? false;
    final o = state['onoff'] as Map<String, dynamic>?;
    return o?['on'] as bool? ?? false;
  }

  /// This device's advertised media inputs (Universal AVR Framework §7 — dynamic
  /// capability detection): read from its own AudioCapabilityConfig (device-reported
  /// or installer-declared depending on the protocol), never a hardcoded brand list.
  /// Empty for non-media devices or media devices with no configured inputs. `type` is
  /// a loose, unvalidated icon hint ("hdmi" | "optical" | "analog" | "tuner" | "usb" |
  /// "bluetooth" | "streaming" | "network" | null) — never required.
  List<({String id, String label, String? type})> get mediaInputs {
    final inputs = capabilityConfig['media']?['inputs'];
    if (inputs is! List) return const [];
    return inputs
        .whereType<Map<String, dynamic>>()
        .map((i) => (
              id: i['id'] as String? ?? '',
              label: (i['label'] as String?) ?? (i['id'] as String?) ?? '',
              type: i['type'] as String?,
            ))
        .where((i) => i.id.isNotEmpty)
        .toList();
  }

  /// This device's selectable DSP/surround/sound-program modes (§ AudioCapabilityConfig
  /// `soundModes`) — brand-specific names passed through verbatim. Empty when the
  /// device has none.
  List<({String id, String label})> get mediaSoundModes {
    final modes = capabilityConfig['media']?['soundModes'];
    if (modes is! List) return const [];
    return modes
        .whereType<Map<String, dynamic>>()
        .map((m) => (id: m['id'] as String? ?? '', label: (m['label'] as String?) ?? (m['id'] as String?) ?? ''))
        .where((m) => m.id.isNotEmpty)
        .toList();
  }

  /// This device's extra homeowner-facing controls (§ AudioCapabilityConfig
  /// `advancedControls`, e.g. a receiver's Sleep Timer) — the ONLY mechanism a
  /// brand-specific control reaches the UI; nothing outside this list is ever rendered
  /// generically. Empty when the device declares none.
  List<MediaAdvancedControl> get mediaAdvancedControls {
    final controls = capabilityConfig['media']?['advancedControls'];
    if (controls is! List) return const [];
    return controls.whereType<Map<String, dynamic>>().map(MediaAdvancedControl.fromJson).toList();
  }

  factory Device.fromJson(Map<String, dynamic> json) => Device(
        id: json['id'] as String,
        name: json['name'] as String,
        supremeType: json['supremeType'] as String,
        roomId: json['roomId'] as String?,
        capabilities: (json['capabilities'] as List<dynamic>)
            .map((c) => (c as Map<String, dynamic>)['kind'] as String)
            .toList(),
        capabilityConfig: {
          for (final c in (json['capabilities'] as List<dynamic>))
            (c as Map<String, dynamic>)['kind'] as String:
                (c['config'] as Map<String, dynamic>?) ?? const {},
        },
        state: (json['state'] as Map<String, dynamic>?) ?? <String, dynamic>{},
        manufacturer: json['manufacturer'] as String?,
        model: json['model'] as String?,
        driverId: json['driverId'] as String?,
        status: json['status'] as String? ?? 'online',
        metadata: (json['metadata'] as Map<String, dynamic>?) ?? const {},
      );
}

/// One entry from `AudioCapabilityConfig.advancedControls` (§7) — a generic,
/// self-describing "extra" homeowner-facing control (e.g. a receiver's Sleep Timer).
/// `key` matches a field this control reads/writes inside the `media` capability's
/// `advanced` state/command bag.
class MediaAdvancedControl {
  MediaAdvancedControl({
    required this.key,
    required this.label,
    required this.kind,
    this.icon,
    this.options = const [],
  });

  final String key;
  final String label;

  /// "toggle" | "select" | "range".
  final String kind;
  final String? icon;
  final List<({String id, String label})> options;

  factory MediaAdvancedControl.fromJson(Map<String, dynamic> json) => MediaAdvancedControl(
        key: json['key'] as String? ?? '',
        label: json['label'] as String? ?? '',
        kind: json['kind'] as String? ?? 'toggle',
        icon: json['icon'] as String?,
        options: ((json['options'] as List?) ?? const [])
            .whereType<Map<String, dynamic>>()
            .map((o) => (id: o['id'] as String? ?? '', label: (o['label'] as String?) ?? (o['id'] as String?) ?? ''))
            .toList(),
      );
}

class HomeView {
  HomeView({required this.homeName, required this.rooms});
  final String homeName;
  final List<Room> rooms;

  factory HomeView.fromJson(Map<String, dynamic> json) => HomeView(
        homeName: (json['home'] as Map<String, dynamic>)['name'] as String,
        rooms: (json['rooms'] as List<dynamic>)
            .map((r) => Room.fromJson(r as Map<String, dynamic>))
            .toList(),
      );
}

class Scene {
  Scene({required this.id, required this.name, required this.icon, this.deviceIds = const []});
  final String id;
  final String name;
  final String? icon;

  /// The device ids this scene drives (from its steps) — used for per-device scene-usage counts.
  final List<String> deviceIds;

  factory Scene.fromJson(Map<String, dynamic> json) => Scene(
        id: json['id'] as String,
        name: json['name'] as String,
        icon: json['icon'] as String?,
        deviceIds: ((json['steps'] as List?) ?? const [])
            .map((s) => (s as Map<String, dynamic>)['deviceId'] as String?)
            .whereType<String>()
            .toSet()
            .toList(),
      );
}

class Camera {
  Camera({
    required this.id,
    required this.name,
    required this.roomId,
    required this.snapshotUrl,
    required this.streamUrl,
  });
  final String id;
  final String name;
  final String? roomId;
  final String? snapshotUrl;
  final String? streamUrl;

  factory Camera.fromJson(Map<String, dynamic> json) => Camera(
        id: json['id'] as String,
        name: json['name'] as String,
        roomId: json['roomId'] as String?,
        snapshotUrl: json['snapshotUrl'] as String?,
        streamUrl: json['streamUrl'] as String?,
      );
}

class CameraStream {
  CameraStream({required this.kind, required this.url});

  /// "hls" | "webrtc" | "rtsp".
  final String kind;
  final String url;

  factory CameraStream.fromJson(Map<String, dynamic> json) => CameraStream(
        kind: json['kind'] as String,
        url: json['url'] as String,
      );
}

class NotificationItem {
  NotificationItem({
    required this.id,
    required this.level,
    required this.title,
    required this.body,
    required this.createdAt,
    required this.readAt,
  });
  final String id;
  final String level;
  final String title;
  final String body;
  final String createdAt;
  final String? readAt;

  bool get unread => readAt == null;

  factory NotificationItem.fromJson(Map<String, dynamic> json) =>
      NotificationItem(
        id: json['id'] as String,
        level: json['level'] as String,
        title: json['title'] as String,
        body: json['body'] as String,
        createdAt: json['createdAt'] as String,
        readAt: json['readAt'] as String?,
      );
}

/// An automation summary for the visual Builder list.
class AutomationSummary {
  AutomationSummary({
    required this.id,
    required this.name,
    required this.enabled,
    required this.triggers,
    required this.conditions,
    required this.actions,
  });
  final String id;
  final String name;
  final bool enabled;
  final List<Map<String, dynamic>> triggers;
  final List<Map<String, dynamic>> conditions;
  final List<Map<String, dynamic>> actions;

  int get triggerCount => triggers.length;
  int get actionCount => actions.length;

  static List<Map<String, dynamic>> _nodes(dynamic v) =>
      (v as List<dynamic>?)?.map((e) => Map<String, dynamic>.from(e as Map)).toList() ?? [];

  factory AutomationSummary.fromJson(Map<String, dynamic> json) =>
      AutomationSummary(
        id: json['id'] as String,
        name: json['name'] as String,
        enabled: json['enabled'] as bool? ?? true,
        triggers: _nodes(json['triggers']),
        conditions: _nodes(json['conditions']),
        actions: _nodes(json['actions']),
      );
}

/// A dashboard favorite referencing a device or a scene.
class Favorite {
  Favorite({required this.type, required this.refId});
  final String type; // 'device' | 'scene'
  final String refId;

  factory Favorite.fromJson(Map<String, dynamic> json) {
    final ref = json['ref'] as Map<String, dynamic>;
    final type = ref['type'] as String;
    return Favorite(type: type, refId: (ref['${type}Id']) as String);
  }
}
