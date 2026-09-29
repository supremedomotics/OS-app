import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../control/control_blocks.dart';

/// Devices — "what the residence is made of" (Golden Master `devices.js`) — and the Device Sheet.
/// Both are layers, not destinations: the inventory is reached from Control ("Devices"), from
/// Home's note about what is not responding, and from a space; a device opens onto its sheet.
///
/// Everything is derived from the Residence State (`inventoryOf`): In use now → Needs attention →
/// function → floor → room → device. A device's sheet is generated from the capabilities it
/// declares with the SAME blocks Control uses, so a control exists only where a device backs it;
/// a device none of them describe shows what the Hub reports and nothing to adjust.
///
/// NOT built, because the contract carries nothing to show: battery, firmware, fault history,
/// signal strength, model/manufacturer detail beyond what a device reports.

/// Opens the inventory as a layer. [spaceId] scopes it to one space; [attentionOnly] shows only
/// what is not responding (opened from Home's note).
///
/// [stacked] when opened from inside another layer (Control): its surface is then opaque so the
/// layer beneath cannot show through.
Future<void> openDevices(BuildContext context,
    {String? spaceId, bool attentionOnly = false, bool stacked = false}) {
  final profile = SurfaceScope.of(context);
  return showSupremeLayer<void>(
    context,
    presentation: shellNavigationFor(profile).controlPresentation,
    fold: profile.fold,
    semanticLabel: attentionOnly ? 'Devices not responding' : 'Devices',
    stacked: stacked,
    builder: (_) => DevicesLayerBody(spaceId: spaceId, attentionOnly: attentionOnly),
  );
}

Future<void> openDeviceSheet(BuildContext context, String deviceId) {
  final profile = SurfaceScope.of(context);
  return showSupremeLayer<void>(
    context,
    presentation: shellNavigationFor(profile).controlPresentation,
    fold: profile.fold,
    semanticLabel: 'Device',
    stacked: true, // always opened from the inventory
    builder: (_) => DeviceSheetBody(deviceId: deviceId),
  );
}

SupremeTextStyles get _t => SupremeTextStyles.resolve(SupremeDensity.comfortable);

Widget _kicker(String s) => Padding(
      padding: const EdgeInsets.only(top: 22, bottom: 4),
      child: Text(s.toUpperCase(),
          style: _t.body.copyWith(
              fontSize: 11, letterSpacing: 2.2, color: const Color(0x66F7F4EE))),
    );

/// The layer's frame: kicker + close, title. The body scrolls.
class _LayerFrame extends StatelessWidget {
  final String kicker;
  final String title;
  final String? subtitle;
  final Widget child;
  final ValueKey<String> frameKey;
  const _LayerFrame(
      {required this.frameKey,
      required this.kicker,
      required this.title,
      required this.child,
      this.subtitle});

  @override
  Widget build(BuildContext context) => Padding(
        key: frameKey,
        padding: const EdgeInsets.fromLTRB(24, 16, 24, 0),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Expanded(
                    child: Text(kicker.toUpperCase(),
                        maxLines: 1, overflow: TextOverflow.ellipsis, style: _t.kicker)),
                SupremeTappable(
                  key: const ValueKey('layer-close'),
                  onTap: () => Navigator.of(context).maybePop(),
                  semanticLabel: 'Close',
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
            Text(title, style: _t.pageTitle.copyWith(fontSize: 34)),
            if (subtitle != null)
              Padding(
                padding: const EdgeInsets.only(top: 4),
                child: Text(subtitle!,
                    style: _t.body.copyWith(fontSize: 15, color: SupremeColorScheme.text2)),
              ),
            const SizedBox(height: 8),
            Expanded(child: child),
          ],
        ),
      );
}

Widget _say(String s) => Text(s, style: _t.body.copyWith(color: SupremeColorScheme.text2));

// ── the inventory ─────────────────────────────────────────────────────────────────────────

class DevicesLayerBody extends ConsumerWidget {
  final String? spaceId;
  final bool attentionOnly;
  const DevicesLayerBody({super.key, this.spaceId, this.attentionOnly = false});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final snap = view?.snapshot;
    final space = spaceId == null ? null : snap?.space(spaceId!);
    final loaded = view != null && snap != null && snap.loaded;
    final inv = loaded ? inventoryOf(snap, inFlight: view.inFlight, spaceId: spaceId) : null;

    final title = attentionOnly ? 'Not responding' : space == null ? 'Devices' : '${space.name} devices';
    final subtitle = inv == null || attentionOnly
        ? null
        : '${inv.total} ${inv.total == 1 ? 'device' : 'devices'}'
            '${inv.attention.isEmpty ? '' : ' · ${inv.attention.length} not responding'}';

    return _LayerFrame(
      frameKey: const ValueKey('devices-layer'),
      kicker: space?.name ?? 'Residence',
      title: title,
      subtitle: subtitle,
      child: inv == null
          ? _say(snap?.reachable == false ? 'Your residence isn’t reachable right now.' : 'Loading…')
          : attentionOnly
              ? _list([
                  if (inv.attention.isEmpty)
                    _say('Everything is responding.')
                  else
                    ..._rows(context, inv.attention, showPlace: true),
                ])
              : inv.total == 0
                  ? _say('No devices are part of this residence yet.')
                  : _list([
                      if (inv.inUse.isNotEmpty) ...[
                        _kicker('In use now'),
                        ..._rows(context, inv.inUse, showPlace: space == null),
                      ],
                      if (inv.attention.isNotEmpty) ...[
                        _kicker('Needs attention'),
                        ..._rows(context, inv.attention, showPlace: space == null),
                      ],
                      _kicker('What the residence is made of'),
                      for (final g in inv.madeOf)
                        ..._group(context, g, space == null,
                            // A floor heading says nothing when everything is on one floor.
                            {
                              for (final x in inv.madeOf)
                                for (final f in x.floors) f.floorId
                            }.length >
                                1),
                    ]),
    );
  }

  Widget _list(List<Widget> children) => ListView(
      key: const ValueKey('devices-list'),
      padding: const EdgeInsets.only(bottom: 32),
      children: children);

  List<Widget> _rows(BuildContext context, List<DeviceEntry> entries, {required bool showPlace}) => [
        for (final e in entries) _DeviceRow(entry: e, showPlace: showPlace),
      ];

  List<Widget> _group(
      BuildContext context, FunctionDevices g, bool multiRoom, bool showFloors) {
    return [
      Padding(
        padding: const EdgeInsets.only(top: 18, bottom: 2),
        child: Row(children: [
          SupremeGlyph(g.function.glyph, size: 22, color: SupremeColorScheme.brassPale),
          const SizedBox(width: 12),
          Text('${g.function.heading} · ${g.count}',
              key: ValueKey('devices-group-${g.function.name}'),
              style: _t.body.copyWith(fontSize: 17, color: SupremeColorScheme.text)),
        ]),
      ),
      for (final f in g.floors) ...[
        if (showFloors && f.label != null)
          Padding(
            padding: const EdgeInsets.only(top: 10, left: 34),
            child: Text(f.label!.toUpperCase(),
                style: _t.body.copyWith(
                    fontSize: 10.5, letterSpacing: 1.8, color: SupremeColorScheme.text3)),
          ),
        for (final r in f.rooms) ...[
          if (multiRoom && r.space != null)
            Padding(
              padding: const EdgeInsets.only(top: 6, left: 34),
              child: Text(r.space!.name,
                  style: _t.body.copyWith(fontSize: 13, color: SupremeColorScheme.text2)),
            ),
          for (final e in r.devices) _DeviceRow(entry: e, showPlace: false, indent: 34),
        ],
      ],
    ];
  }
}

class _DeviceRow extends StatelessWidget {
  final DeviceEntry entry;
  final bool showPlace;
  final double indent;
  const _DeviceRow({required this.entry, required this.showPlace, this.indent = 0});

  @override
  Widget build(BuildContext context) {
    final place = showPlace ? entry.spaceName : null;
    final said = [if (place != null) place, entry.sentence].join(' · ');
    return SupremeTappable(
      key: ValueKey('device-${entry.device.id}'),
      onTap: () => openDeviceSheet(context, entry.device.id),
      semanticLabel: '${entry.device.name}. $said',
      radius: 4,
      child: Container(
        constraints: const BoxConstraints(minHeight: 60),
        padding: EdgeInsets.only(left: indent),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Row(children: [
          Expanded(
            child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(entry.device.name, style: _t.body.copyWith(fontSize: 16)),
                  const SizedBox(height: 2),
                  Text(said,
                      style: _t.body.copyWith(
                          fontSize: 13.5,
                          color: entry.needsAttention
                              ? SupremeColorScheme.brassPale
                              : SupremeColorScheme.text2)),
                ]),
          ),
          const SizedBox(width: 10, height: 16, child: CustomPaint(painter: _Chevron())),
        ]),
      ),
    );
  }
}

// ── the device sheet ──────────────────────────────────────────────────────────────────────

class DeviceSheetBody extends ConsumerWidget {
  final String deviceId;
  const DeviceSheetBody({super.key, required this.deviceId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final snap = view?.snapshot;
    final d = snap?.devices[deviceId];

    if (view == null || snap == null || !snap.loaded || d == null) {
      return _LayerFrame(
        frameKey: const ValueKey('device-sheet'),
        kicker: 'Device',
        title: 'Device',
        child: _say(view == null || !(snap?.loaded ?? false)
            ? (snap?.reachable == false ? 'Your residence isn’t reachable right now.' : 'Loading…')
            : 'This device is no longer part of the residence.'),
      );
    }

    final fn = functionOf(d);
    final place = d.roomId == null ? null : snap.space(d.roomId!)?.name;
    final reported = reportedWords(d.reportedAt, DateTime.now());
    final blocks = <Widget>[];
    switch (fn) {
      case DeviceFunction.lighting:
        blocks.add(LightsBlock(
            lights: RoomLights.of([d], view.inFlight)!, view: view, title: 'Lighting'));
      case DeviceFunction.shades:
        blocks.add(ShadesBlock(shades: RoomShades.of([d], view.inFlight)!, view: view, title: 'Position'));
      case DeviceFunction.climate:
        blocks.add(ClimateBlock(
            zone: RoomClimate.allOf([d], view.inFlight).first, view: view, title: 'Climate'));
      case DeviceFunction.media:
        blocks.add(MusicBlock(
            music: RoomMusic.allOf([d], view.inFlight).first, view: view, title: 'Music'));
      case DeviceFunction.other:
        break;
    }

    return _LayerFrame(
      frameKey: const ValueKey('device-sheet'),
      kicker: [fn.heading, if (place != null) place].join(' · '),
      title: d.name,
      subtitle: deviceStateSentence(d, view.inFlight),
      child: ListView(
        key: const ValueKey('device-sheet-list'),
        padding: const EdgeInsets.only(bottom: 32),
        children: [
          if (!d.isOnline)
            Padding(
              padding: const EdgeInsets.only(top: 12),
              child: SupremeStatus('${d.name} isn’t responding. What is shown is what it last reported.'),
            ),
          ...blocks,
          if (fn == DeviceFunction.other && d.isOnline)
            Padding(
                padding: const EdgeInsets.only(top: 16),
                child: _say('Nothing to adjust here.')),
          _kicker('Information'),
          _info('Where', place ?? 'Not placed in a space'),
          if (reported != null) _info('Last reported', reported),
        ],
      ),
    );
  }

  Widget _info(String k, String v) => Container(
        constraints: const BoxConstraints(minHeight: 48),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
          Text(k, style: _t.body.copyWith(fontSize: 15, color: SupremeColorScheme.text2)),
          Flexible(child: Text(v, textAlign: TextAlign.right, style: _t.body.copyWith(fontSize: 15))),
        ]),
      );
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
