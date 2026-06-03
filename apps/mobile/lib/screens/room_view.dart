import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

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
        data: (view) => SafeArea(
          child: PageView(
            children: [
              for (final room in view.rooms) RoomView(roomId: room.id, roomName: room.name),
            ],
          ),
        ),
      ),
    );
  }
}

/// A single room: aggregate device tiles using the Aureon [FillTile] grammar.
/// Commands go out optimistically over the SDK; the WSS stream reconciles state.
class RoomView extends ConsumerStatefulWidget {
  const RoomView({super.key, required this.roomId, required this.roomName});

  final String roomId;
  final String roomName;

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

  Future<void> _setBrightness(Device device, double fraction) async {
    final client = ref.read(clientProvider);
    await client.command(device.id, {
      'capability': 'brightness',
      'action': 'set',
      'level': (fraction * 100).round(),
    });
  }

  Future<void> _toggle(Device device) async {
    final client = ref.read(clientProvider);
    final cap = device.capabilities.contains('brightness') ? 'brightness' : 'onoff';
    await client.command(device.id, {
      'capability': cap,
      'action': device.isOn ? 'off' : 'on',
    });
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(AureonSpacing.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const SizedBox(height: AureonSpacing.lg),
          Text(widget.roomName, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: AureonSpacing.lg),
          Expanded(
            child: _loading
                ? const Center(child: CircularProgressIndicator())
                : GridView.count(
                    crossAxisCount: 2,
                    mainAxisSpacing: AureonSpacing.md,
                    crossAxisSpacing: AureonSpacing.md,
                    childAspectRatio: 1.4,
                    children: [
                      for (final device in _devices)
                        FillTile(
                          label: device.name,
                          subtitle: device.isOn
                              ? '${(device.brightnessFraction * 100).round()}%'
                              : 'Off',
                          value: device.brightnessFraction,
                          on: device.isOn,
                          onToggle: () => _toggle(device),
                          onChanged: (v) => _setBrightness(device, v),
                        ),
                    ],
                  ),
          ),
          Center(
            child: Text(widget.roomName,
                style: Theme.of(context).textTheme.labelMedium),
          ),
        ],
      ),
    );
  }
}
