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
    this.manufacturer,
    this.model,
    this.driverId,
    this.status = 'online',
  });

  final String id;
  final String name;
  final String supremeType;
  final String? roomId;
  final List<String> capabilities;

  /// Real device metadata (§ Device Manager). Nullable — a device may not declare a make/model or
  /// be bound to a driver. `status` is the platform's online/offline/unavailable enum.
  final String? manufacturer;
  final String? model;
  final String? driverId;
  final String status;

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

  factory Device.fromJson(Map<String, dynamic> json) => Device(
        id: json['id'] as String,
        name: json['name'] as String,
        supremeType: json['supremeType'] as String,
        roomId: json['roomId'] as String?,
        capabilities: (json['capabilities'] as List<dynamic>)
            .map((c) => (c as Map<String, dynamic>)['kind'] as String)
            .toList(),
        state: (json['state'] as Map<String, dynamic>?) ?? <String, dynamic>{},
        manufacturer: json['manufacturer'] as String?,
        model: json['model'] as String?,
        driverId: json['driverId'] as String?,
        status: json['status'] as String? ?? 'online',
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
