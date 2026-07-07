import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../room_image.dart';
import 'device_detail.dart';
import 'device_sheet.dart';

/// Ovio iPad room experience (§11.1): a bento mosaic of light tiles around a central
/// multi-light colour disc. Each colour light is a draggable node; long-press a tile for
/// Dim / Select on colour picker / Turn off. Used at tablet width.
class TabletRoomView extends ConsumerStatefulWidget {
  const TabletRoomView({super.key, required this.roomId, required this.roomName, this.areaType, this.heroImageUrl});
  final String roomId;
  final String roomName;
  final String? areaType;
  final String? heroImageUrl;

  @override
  ConsumerState<TabletRoomView> createState() => _TabletRoomViewState();
}

class _TabletRoomViewState extends ConsumerState<TabletRoomView> {
  List<Device> _devices = [];
  bool _loading = true;
  bool _colour = true;
  String? _selected;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final devices = await ref.read(clientProvider).devicesInRoom(widget.roomId);
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _loading = false;
    });
  }

  List<Device> get _lights => _devices.where((d) => d.capabilities.contains('color')).toList();

  void _setColour(Device d, double hue, double sat) {
    final c = Map<String, dynamic>.from((d.state['color'] as Map<String, dynamic>?) ?? {});
    c['hue'] = hue;
    c['saturation'] = (sat * 100);
    c['on'] = true;
    setState(() {
      final i = _devices.indexWhere((x) => x.id == d.id);
      if (i >= 0) {
        _devices[i] = Device(id: d.id, name: d.name, supremeType: d.supremeType, roomId: d.roomId, capabilities: d.capabilities, state: {...d.state, 'color': c});
      }
    });
    ref.read(clientProvider).command(d.id, {'capability': 'color', 'hue': hue.round(), 'saturation': (sat * 100).round()});
  }

  // White mode drives the correlated colour temperature (tunable white) on the same `color` capability.
  void _setKelvin(Device d, double kelvin) {
    final k = kelvin.round();
    final c = Map<String, dynamic>.from((d.state['color'] as Map<String, dynamic>?) ?? {});
    c['kelvin'] = k;
    c['on'] = true;
    setState(() {
      final i = _devices.indexWhere((x) => x.id == d.id);
      if (i >= 0) {
        _devices[i] = Device(id: d.id, name: d.name, supremeType: d.supremeType, roomId: d.roomId, capabilities: d.capabilities, state: {...d.state, 'color': c});
      }
    });
    ref.read(clientProvider).command(d.id, {'capability': 'color', 'kelvin': k});
  }

  Future<void> _menu(Device d, Offset pos) async {
    final v = await showMenu<String>(
      context: context,
      position: RelativeRect.fromLTRB(pos.dx, pos.dy, pos.dx, pos.dy),
      items: const [
        PopupMenuItem(value: 'dim', child: Text('Dim')),
        PopupMenuItem(value: 'pick', child: Text('Select on colour picker')),
        PopupMenuItem(value: 'off', child: Text('Turn off')),
      ],
    );
    if (v == 'dim' && mounted) {
      await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => DeviceDetailScreen(device: d)));
      _load();
    } else if (v == 'pick') {
      setState(() { _selected = d.id; _colour = true; });
    } else if (v == 'off') {
      ref.read(clientProvider).command(d.id, {'capability': 'brightness', 'action': 'off'});
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) return const Center(child: CircularProgressIndicator());
    final scheme = Theme.of(context).colorScheme;
    final lights = _lights;
    final others = _devices.where((d) => !d.capabilities.contains('color')).toList();
    final onCount = lights.where((d) => (d.state['color'] as Map<String, dynamic>?)?['on'] == true).length;
    final discLights = [
      for (final d in lights)
        DiscLight(
          id: d.id,
          hue: ((d.state['color'] as Map<String, dynamic>?)?['hue'] as num?)?.toDouble() ?? 40,
          saturation: (((d.state['color'] as Map<String, dynamic>?)?['saturation'] as num?)?.toDouble() ?? 70) / 100,
          kelvin: ((d.state['color'] as Map<String, dynamic>?)?['kelvin'] as num?)?.toDouble() ?? 3000,
          on: (d.state['color'] as Map<String, dynamic>?)?['on'] == true,
        ),
    ];

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Same hub-served hero image as the phone room + web, so a room looks identical
            // across every surface.
            Builder(builder: (_) {
              final st = roomStyle(widget.roomName, widget.areaType);
              final photo = ref.watch(roomPhotoProvider((name: widget.roomName, areaType: widget.areaType, heroImageUrl: widget.heroImageUrl))).valueOrNull;
              return RoomHero(
                title: widget.roomName,
                imageUrl: photo,
                gradientColors: [st.from, st.to],
                motif: st.emoji,
                height: 120,
              );
            }),
            const SizedBox(height: AureonSpacing.md),
            Expanded(
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  // Left: aggregate + master
                  SizedBox(
                    width: 220,
                    child: Column(children: [
                      Expanded(child: _bento(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.end, children: [
                        Text('$onCount', style: const TextStyle(fontSize: 44, fontWeight: FontWeight.w600)),
                        Text(onCount == 1 ? 'light on' : 'lights on', style: Theme.of(context).textTheme.labelMedium),
                      ]))),
                      const SizedBox(height: AureonSpacing.md),
                      _bento(child: Row(children: [
                        Container(width: 14, height: 14, decoration: const BoxDecoration(color: AureonGold.c400, shape: BoxShape.circle)),
                        const SizedBox(width: 10),
                        const Text('Lights', style: TextStyle(fontWeight: FontWeight.w600)),
                      ])),
                    ]),
                  ),
                  // Centre: disc
                  Expanded(
                    child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                      LayoutBuilder(builder: (context, c) {
                        final size = (c.maxWidth.clamp(220.0, 420.0)) - 20;
                        return MultiLightDisc(
                          lights: discLights,
                          colour: _colour,
                          selected: _selected,
                          size: size,
                          onSelect: (id) => setState(() => _selected = id),
                          onChange: (id, h, s) => _setColour(_devices.firstWhere((d) => d.id == id), h, s),
                          onKelvin: (id, k) => _setKelvin(_devices.firstWhere((d) => d.id == id), k),
                        );
                      }),
                      const SizedBox(height: AureonSpacing.md),
                      GestureDetector(
                        onTap: () => setState(() => _colour = !_colour),
                        child: Container(
                          width: 32,
                          height: 32,
                          decoration: BoxDecoration(
                            shape: BoxShape.circle,
                            gradient: const SweepGradient(colors: [Colors.red, Colors.yellow, Colors.green, Colors.cyan, Colors.blue, Colors.purple, Colors.red]),
                            border: Border.all(color: scheme.surface, width: 2),
                          ),
                        ),
                      ),
                    ]),
                  ),
                  // Right: bento mosaic
                  SizedBox(
                    width: 300,
                    child: GridView.count(
                      crossAxisCount: 2,
                      mainAxisSpacing: AureonSpacing.md,
                      crossAxisSpacing: AureonSpacing.md,
                      childAspectRatio: 1.2,
                      children: [
                        for (final d in lights)
                          GestureDetector(
                            onTap: () => setState(() => _selected = d.id),
                            onDoubleTap: () async { await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => DeviceDetailScreen(device: d))); _load(); },
                            onLongPressStart: (e) => _menu(d, e.globalPosition),
                            child: _bento(
                              selected: _selected == d.id,
                              child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                                Container(width: 16, height: 16, decoration: BoxDecoration(
                                  color: (d.state['color'] as Map<String, dynamic>?)?['on'] == true
                                      ? HSVColor.fromAHSV(1, (((d.state['color'] as Map<String, dynamic>?)?['hue'] as num?)?.toDouble() ?? 40) % 360, 0.85, 0.6).toColor()
                                      : scheme.outlineVariant,
                                  shape: BoxShape.circle,
                                )),
                                Text(d.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                              ]),
                            ),
                          ),
                        for (final d in others)
                          GestureDetector(
                            onTap: () => showDeviceSheet(context, d).then((_) => _load()),
                            child: _bento(child: Align(alignment: Alignment.bottomLeft, child: Text(d.name, style: const TextStyle(fontWeight: FontWeight.w600)))),
                          ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _bento({required Widget child, bool selected = false}) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Theme.of(context).cardTheme.color ?? scheme.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: selected ? AureonGold.c400 : scheme.outlineVariant.withValues(alpha: 0.4), width: selected ? 2 : 1),
      ),
      child: child,
    );
  }
}
