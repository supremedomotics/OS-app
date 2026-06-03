/// Supreme domain models (Dart mirror of @supreme/domain-model). Kept minimal for
/// Phase 0; the full set is generated from `supreme-contracts` in Phase 1.

class Room {
  Room({required this.id, required this.name, required this.areaType, this.heroImageUrl});

  final String id;
  final String name;
  final String areaType;
  final String? heroImageUrl;

  factory Room.fromJson(Map<String, dynamic> json) => Room(
        id: json['id'] as String,
        name: json['name'] as String,
        areaType: json['areaType'] as String? ?? 'other',
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
  });

  final String id;
  final String name;
  final String supremeType;
  final String? roomId;
  final List<String> capabilities;

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
