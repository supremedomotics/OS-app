import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../devices/devices_layer.dart';
import 'control_blocks.dart';

/// The body of the Control layer (Golden Master `control.js`): not a page and not a dashboard — a
/// quiet instrument that emerges from where the homeowner is. Opened from a space it is that
/// space, and lists only the systems the space actually has; from anywhere else it is the whole
/// residence. Each system opens onto its controls (the shared blocks).
///
/// Everything shown is read from the Residence State; every action is a tracked command.
///
/// Beneath the systems, "Physical objects" opens the Devices inventory (and from it a device's
/// sheet) in the same scope.
///
/// NOT YET BUILT (flagged in the implementation map, not drawn inert): Protection (no arming /
/// contact contract), the Experience scope, and the line-drawing instruments that head each
/// system.
class ControlLayerBody extends ConsumerStatefulWidget {
  /// The space Control was opened from; null = the whole residence.
  final String? spaceId;
  const ControlLayerBody({super.key, this.spaceId});
  @override
  ConsumerState<ControlLayerBody> createState() => _ControlLayerBodyState();
}

class _ControlLayerBodyState extends ConsumerState<ControlLayerBody> {
  // Presentation state only: which system is open.
  ControlSystemId? _system;

  @override
  Widget build(BuildContext context) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final snap = view?.snapshot;
    final space = widget.spaceId == null ? null : snap?.space(widget.spaceId!);
    final title = space?.name ?? 'Residence';
    final devices = snap == null
        ? const <DeviceRecord>[]
        : widget.spaceId == null
            ? snap.devices.values.toList()
            : snap.devicesIn(widget.spaceId!);
    final systems =
        view == null ? const <ControlSystem>[] : controlSystems(devices, view.inFlight);
    final open = systems.where((s) => s.id == _system).firstOrNull;
    final inv = snap == null || !snap.loaded
        ? null
        : inventoryOf(snap, inFlight: view!.inFlight, spaceId: widget.spaceId);

    return Padding(
      key: const ValueKey('control-layer'),
      padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                  child: Text(open == null ? 'CONTROL' : title.toUpperCase(),
                      maxLines: 1, overflow: TextOverflow.ellipsis, style: text.kicker)),
              SupremeTappable(
                key: const ValueKey('control-close'),
                onTap: () => Navigator.of(context).maybePop(),
                semanticLabel: 'Close control',
                radius: 22,
                child: const SizedBox(
                  width: 44,
                  height: 44,
                  child: Center(child: SupremeGlyph('close', size: 22)),
                ),
              ),
            ],
          ),
          const SizedBox(height: 4),
          Row(children: [
            if (open != null)
              Padding(
                padding: const EdgeInsets.only(right: 12),
                child: SupremeTappable(
                  key: const ValueKey('control-back'),
                  onTap: () => setState(() => _system = null),
                  semanticLabel: 'Back to $title control',
                  radius: 22,
                  child: const SizedBox(
                      width: 44,
                      height: 44,
                      child: Center(child: SupremeGlyph('arrow_back', size: 20))),
                ),
              ),
            Expanded(
                child: Text(open?.name ?? title,
                    style: text.pageTitle.copyWith(fontSize: 34))),
          ]),
          const SizedBox(height: 12),
          Expanded(
            child: view == null || snap == null || !snap.loaded
                ? Text(
                    snap?.reachable == false
                        ? 'Your residence isn’t reachable right now.'
                        : 'Loading…',
                    style: text.body.copyWith(color: SupremeColorScheme.text2))
                : open != null
                    ? _System(system: open, devices: devices, view: view, snap: snap)
                    : systems.isEmpty && (inv == null || inv.total == 0)
                        ? Text('Nothing to adjust here.',
                            style: text.body.copyWith(color: SupremeColorScheme.text2))
                        : _Root(
                            systems: systems,
                            inventory: inv,
                            onOpen: (s) => setState(() => _system = s.id),
                            onOpenDevices: () =>
                                openDevices(context, spaceId: widget.spaceId, stacked: true)),
          ),
        ],
      ),
    );
  }
}

class _Root extends StatelessWidget {
  final List<ControlSystem> systems;
  final DeviceInventory? inventory;
  final ValueChanged<ControlSystem> onOpen;
  final VoidCallback onOpenDevices;
  const _Root(
      {required this.systems,
      required this.inventory,
      required this.onOpen,
      required this.onOpenDevices});

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final groups = <String, List<ControlSystem>>{};
    for (final s in systems) {
      groups.putIfAbsent(s.group, () => []).add(s);
    }
    return ListView(padding: const EdgeInsets.only(bottom: 24), children: [
      for (final g in groups.entries) ...[
        Padding(
          padding: const EdgeInsets.only(top: 18, bottom: 4),
          child: Text(g.key.toUpperCase(),
              style: text.body.copyWith(
                  fontSize: 11, letterSpacing: 2.2, color: const Color(0x66F7F4EE))),
        ),
        for (final s in g.value)
          SupremeTappable(
            key: ValueKey('control-system-${s.id.name}'),
            onTap: () => onOpen(s),
            semanticLabel: '${s.name}. ${s.summary}',
            radius: 4,
            child: Container(
              constraints: const BoxConstraints(minHeight: 68),
              decoration: const BoxDecoration(
                  border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
              child: Row(children: [
                SupremeGlyph(s.glyph, size: 26, color: SupremeColorScheme.brassPale),
                const SizedBox(width: 18),
                Expanded(
                  child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(s.name, style: text.body.copyWith(fontSize: 17)),
                        const SizedBox(height: 2),
                        Text(s.summary,
                            style: text.body.copyWith(
                                fontSize: 14, color: SupremeColorScheme.text2)),
                      ]),
                ),
                // Drawn, not typeset: no glyph the font lacks can turn into a box.
                const SizedBox(width: 10, height: 16, child: CustomPaint(painter: _Chevron())),
              ]),
            ),
          ),
      ],
      if (inventory != null && inventory!.total > 0) ...[
        Padding(
          padding: const EdgeInsets.only(top: 18, bottom: 4),
          child: Text('PHYSICAL OBJECTS',
              style: text.body.copyWith(
                  fontSize: 11, letterSpacing: 2.2, color: const Color(0x66F7F4EE))),
        ),
        SupremeTappable(
          key: const ValueKey('control-devices'),
          onTap: onOpenDevices,
          semanticLabel: 'Devices. ${_devicesSummary(inventory!)}',
          radius: 4,
          child: Container(
            constraints: const BoxConstraints(minHeight: 68),
            decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
            child: Row(children: [
              const SupremeGlyph('object', size: 26, color: SupremeColorScheme.brassPale),
              const SizedBox(width: 18),
              Expanded(
                child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text('Devices', style: text.body.copyWith(fontSize: 17)),
                      const SizedBox(height: 2),
                      Text(_devicesSummary(inventory!),
                          style: text.body.copyWith(
                              fontSize: 14,
                              color: inventory!.attention.isEmpty
                                  ? SupremeColorScheme.text2
                                  : SupremeColorScheme.brassPale)),
                    ]),
              ),
              const SizedBox(width: 10, height: 16, child: CustomPaint(painter: _Chevron())),
            ]),
          ),
        ),
      ],
    ]);
  }
}

String _devicesSummary(DeviceInventory inv) =>
    'All ${inv.total} ${inv.total == 1 ? 'device' : 'devices'}'
    '${inv.attention.isEmpty ? '' : ' · ${inv.attention.length} not responding'}';

class _System extends StatelessWidget {
  final ControlSystem system;
  final List<DeviceRecord> devices;
  final ResidenceView view;
  final ResidenceSnapshot snap;
  const _System(
      {required this.system,
      required this.devices,
      required this.view,
      required this.snap});

  String _where(DeviceRecord d) =>
      (d.roomId == null ? null : snap.space(d.roomId!)?.name) ?? d.name;

  @override
  Widget build(BuildContext context) {
    final blocks = <Widget>[];
    switch (system.id) {
      case ControlSystemId.lighting:
        final l = RoomLights.of(devices, view.inFlight);
        if (l != null) {
          blocks.add(LightsBlock(
              lights: l, view: view, title: l.lights.length == 1 ? 'Lights' : 'All lights'));
        }
      case ControlSystemId.shades:
        final s = RoomShades.of(devices, view.inFlight);
        if (s != null) blocks.add(ShadesBlock(shades: s, view: view));
      case ControlSystemId.climate:
        final zones = RoomClimate.allOf(devices, view.inFlight);
        for (final z in zones) {
          blocks.add(ClimateBlock(
              zone: z, view: view, title: zones.length > 1 ? _where(z.device) : 'Climate'));
        }
      case ControlSystemId.media:
        final m = RoomMusic.allOf(devices, view.inFlight);
        for (final x in m) {
          blocks.add(MusicBlock(
              music: x, view: view, title: m.length > 1 ? _where(x.device) : 'Music'));
        }
    }
    return ListView(
        key: ValueKey('control-system-page-${system.id.name}'),
        padding: const EdgeInsets.only(bottom: 32),
        children: blocks);
  }
}

class _Chevron extends CustomPainter {
  const _Chevron();
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()
      ..color = const Color(0x8FF7F4EE)
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.4
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    canvas.drawPath(
        Path()
          ..moveTo(1.5, 1.5)
          ..lineTo(size.width - 1.5, size.height / 2)
          ..lineTo(1.5, size.height - 1.5),
        p);
  }

  @override
  bool shouldRepaint(_Chevron o) => false;
}
