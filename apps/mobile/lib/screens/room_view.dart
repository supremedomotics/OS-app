import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../room_image.dart';
import 'device_detail.dart';
import 'device_sheet.dart';
import 'tablet_room.dart';

/// Room-first horizontal pager (§11.1): swipe between rooms, the current room
/// name centered at the bottom. Each page is a [RoomView].
class HomePager extends ConsumerWidget {
  const HomePager({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final home = ref.watch(homeProvider);
    return Scaffold(
      body: home.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load home\n$e')),
        data: (view) {
          // Tablet/desktop widths get the Ovio bento + multi-light disc layout.
          final wide = MediaQuery.of(context).size.width >= 900;
          return SafeArea(
            child: PageView(
              children: [
                for (final room in view.rooms)
                  wide
                      ? TabletRoomView(roomId: room.id, roomName: room.name, areaType: room.areaType, heroImageUrl: room.heroImageUrl)
                      : RoomView(roomId: room.id, roomName: room.name, areaType: room.areaType, heroImageUrl: room.heroImageUrl),
              ],
            ),
          );
        },
      ),
    );
  }
}

({IconData icon, bool slidable, double fill, bool on, String value}) _tileSpec(Device d) {
  final caps = d.capabilities;
  if (caps.contains('brightness')) {
    return (icon: Icons.lightbulb_outline, slidable: true, fill: d.brightnessFraction, on: d.isOn, value: d.isOn ? '${(d.brightnessFraction * 100).round()}%' : 'Off');
  }
  if (caps.contains('position')) {
    final p = (d.state['position'] as Map<String, dynamic>?)?['position'] as num? ?? 0;
    return (icon: Icons.blinds_outlined, slidable: true, fill: p / 100.0, on: p > 0, value: '${p.round()}%');
  }
  if (caps.contains('media')) {
    final m = d.state['media'] as Map<String, dynamic>?;
    final playing = (m?['playback'] as String?) == 'playing';
    return (icon: Icons.music_note_outlined, slidable: false, fill: 0, on: playing, value: playing ? 'Playing' : 'Idle');
  }
  if (caps.contains('fan')) {
    final on = (d.state['fan'] as Map<String, dynamic>?)?['on'] as bool? ?? false;
    return (icon: Icons.mode_fan_off_outlined, slidable: false, fill: 0, on: on, value: on ? 'On' : 'Off');
  }
  if (caps.contains('vacuum')) {
    final st = (d.state['vacuum'] as Map<String, dynamic>?)?['status'] as String? ?? 'idle';
    return (icon: Icons.cleaning_services_outlined, slidable: false, fill: 0, on: st == 'cleaning', value: st[0].toUpperCase() + st.substring(1));
  }
  if (caps.contains('lock')) {
    final locked = (d.state['lock'] as Map<String, dynamic>?)?['locked'] as bool? ?? true;
    return (icon: locked ? Icons.lock_outline : Icons.lock_open_outlined, slidable: false, fill: 0, on: !locked, value: locked ? 'Locked' : 'Unlocked');
  }
  if (caps.contains('sensor')) {
    final s = d.state['sensor'] as Map<String, dynamic>?;
    return (icon: Icons.sensors_outlined, slidable: false, fill: 0, on: false, value: '${(s?['value'] as num?) ?? '—'} ${(s?['unit'] as String?) ?? ''}'.trim());
  }
  return (icon: Icons.toggle_on_outlined, slidable: false, fill: d.isOn ? 1 : 0, on: d.isOn, value: d.isOn ? 'On' : 'Off');
}

/// A single room: aggregate device tiles using the Aureon [FillTile] grammar.
/// Commands go out optimistically over the SDK; the WSS stream reconciles state.
class RoomView extends ConsumerStatefulWidget {
  const RoomView({super.key, required this.roomId, required this.roomName, this.areaType, this.heroImageUrl});

  final String roomId;
  final String roomName;
  final String? areaType;
  final String? heroImageUrl;

  @override
  ConsumerState<RoomView> createState() => _RoomViewState();
}

class _RoomViewState extends ConsumerState<RoomView> {
  List<Device> _devices = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    _listenToStream();
    // First view of a room with no stored hero → have the hub download & save one locally, then
    // refresh the home so the hub-served (identical-everywhere) image replaces the stock fallback.
    ensureRoomHero(ref.read(clientProvider), widget.roomId, widget.heroImageUrl).then((pinned) {
      if (pinned && mounted) ref.invalidate(homeProvider);
    });
  }

  Future<void> _load() async {
    final client = ref.read(clientProvider);
    final devices = await client.devicesInRoom(widget.roomId);
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _loading = false;
    });
  }

  void _listenToStream() {
    final stream = ref.read(streamProvider);
    if (stream == null) return;
    stream.subscribe([widget.roomId]);
    stream.states.listen((delta) {
      if (!mounted) return;
      final idx = _devices.indexWhere((d) => d.id == delta.deviceId);
      if (idx < 0) return;
      final d = _devices[idx];
      setState(() {
        _devices[idx] = Device(
          id: d.id,
          name: d.name,
          supremeType: d.supremeType,
          roomId: d.roomId,
          capabilities: d.capabilities,
          state: {...d.state, delta.state['kind'] as String: delta.state},
        );
      });
    });
  }

  Future<void> _drag(Device device, double fraction) async {
    final client = ref.read(clientProvider);
    if (device.capabilities.contains('brightness')) {
      await client.command(device.id, {'capability': 'brightness', 'action': 'set', 'level': (fraction * 100).round()});
    } else if (device.capabilities.contains('position')) {
      await client.command(device.id, {'capability': 'position', 'action': 'set', 'position': (fraction * 100).round()});
    }
  }

  Future<void> _tap(Device device) async {
    final caps = device.capabilities;
    // Lights get the full-screen lighting detail; everything else opens an Ovio sheet.
    if (caps.contains('brightness') || caps.contains('color')) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => DeviceDetailScreen(device: device)));
      _load();
      return;
    }
    if (['temperature', 'position', 'lock', 'fan', 'vacuum', 'media', 'onoff'].any(caps.contains)) {
      await showDeviceSheet(context, device);
      _load();
    }
  }

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(AureonSpacing.lg),
      children: [
        const SizedBox(height: AureonSpacing.sm),
        RoomHero(
          title: widget.roomName,
          imageUrl: roomImageUrl(ref.read(clientProvider), widget.roomName, widget.areaType, widget.heroImageUrl),
          statusValue: '${_devices.length}',
          statusLabel: _devices.length == 1 ? 'device' : 'devices',
          height: 200,
        ),
        const SizedBox(height: AureonSpacing.lg),
        if (_loading)
          const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
        else
          for (final device in _devices)
            Padding(
              padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
              child: Builder(builder: (context) {
                final spec = _tileSpec(device);
                return DeviceControlTile(
                  icon: spec.icon,
                  name: device.name,
                  valueLabel: spec.value,
                  fill: spec.fill,
                  on: spec.on,
                  slidable: spec.slidable,
                  onChanged: spec.slidable ? (v) => _drag(device, v) : null,
                  onTap: () => _tap(device),
                );
              }),
            ),
        const SizedBox(height: AureonSpacing.md),
        Center(child: Text(widget.roomName, style: Theme.of(context).textTheme.labelMedium)),
      ],
    );
  }
}
