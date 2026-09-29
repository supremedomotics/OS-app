import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../residence/panel_residence.dart';
import 'experience_activation.dart';

/// The panel's normal, locked-scope room experience (§Phase7-7, §Phase8-2).
/// Branches on [AdaptiveProfile.panelMode] directly (five real tiers, not three) because Phase 8
/// asks each tier to show a genuinely different set of content, not just a different arrangement
/// of the same content (§Phase8-3..7).
///
/// Everything shown is derived from the panel's [PanelResidence] (the canonical Residence State):
/// a control appears only where the space's devices declare the capability, its value is what the
/// devices REPORT, and a command is confirmed only by a device report. With no residence — the
/// panel has not been commissioned to a Hub — the room says so instead of drawing controls that
/// would change nothing. [connected] disables every control when the Hub link is down
/// (§Phase8-15) rather than letting a homeowner issue a command that cannot execute.
class RoomExperienceScreen extends StatelessWidget {
  final String roomName;

  /// The Hub's id for this space (an assigned room or a scoped area).
  final String spaceId;
  final bool connected;
  final Widget? headerTrailing;

  const RoomExperienceScreen({
    super.key,
    required this.roomName,
    required this.spaceId,
    this.connected = true,
    this.headerTrailing,
  });

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    return PanelResidenceBuilder(builder: (context, residence) {
      if (residence == null || !residence.snapshot.loaded || residence.snapshot.space(spaceId) == null) {
        return _Waiting(
            roomName: roomName,
            headerTrailing: headerTrailing,
            message: residence == null
                ? 'This panel is not connected to a residence yet.'
                : residence.snapshot.loaded
                    ? 'This room is not part of the residence.'
                    : 'Waiting for the residence…');
      }
      final b = _Room(residence, spaceId, connected && residence.connected);
      return switch (profile.panelMode) {
        PanelPresentationMode.micro => _MicroExperience(roomName: roomName, room: b),
        PanelPresentationMode.compact =>
          _CompactExperience(roomName: roomName, room: b, headerTrailing: headerTrailing),
        PanelPresentationMode.standard =>
          _StandardExperience(roomName: roomName, room: b, headerTrailing: headerTrailing),
        PanelPresentationMode.expanded =>
          _ExpandedExperience(roomName: roomName, room: b, headerTrailing: headerTrailing),
        PanelPresentationMode.immersive =>
          _ImmersiveExperience(roomName: roomName, room: b, headerTrailing: headerTrailing),
      };
    });
  }
}

/// One space's controls, derived from the residence on every build. Holds nothing.
class _Room {
  final PanelResidence r;
  final String spaceId;
  final bool enabled;

  late final ResidenceSnapshot snap = r.snapshot;
  late final List<DeviceRecord> devices = snap.devicesIn(spaceId);
  late final Iterable<CommandRecord> inFlight = r.tracker.inFlight;
  late final RoomLights? lights = RoomLights.of(devices, inFlight);
  late final RoomShades? shades = RoomShades.of(devices, inFlight);
  late final RoomClimate? climate = RoomClimate.allOf(devices, inFlight).firstOrNull;
  late final RoomMusic? music = RoomMusic.allOf(devices, inFlight).firstOrNull;
  late final List<Experience> experiences = spaceExperiences(snap, spaceId);

  _Room(this.r, this.spaceId, this.enabled);

  String get summary {
    final text = spaceSummary(snap, spaceId);
    return text.isEmpty ? 'Nothing is on' : text;
  }

  ConfirmationState _confirm({required bool pending, required bool failed}) => pending
      ? ConfirmationState.requested
      : failed
          ? ConfirmationState.failed
          : ConfirmationState.confirmed;

  Widget? lighting() {
    final l = lights;
    if (l == null) return null;
    final ids = [for (final d in l.lights) d.id];
    return LightingControl(
      on: l.onCount > 0,
      confirmation: _confirm(
        pending: l.pendingPower || l.pendingLevel != null,
        failed: l.online.isEmpty ||
            failedRecently(r.tracker, ids, 'onoff') != null ||
            failedRecently(r.tracker, ids, 'brightness') != null,
      ),
      onToggle: enabled && l.online.isNotEmpty ? (_) => r.run(l.toggle()) : null,
      onMoodChanged: null,
    );
  }

  Widget? shadesControl() {
    final s = shades;
    if (s == null) return null;
    final pos = s.pendingPosition ?? s.position;
    return ShadesControl(
      position: pos == null
          ? ShadePosition.custom
          : pos >= 95
              ? ShadePosition.open
              : pos <= 5
                  ? ShadePosition.closed
                  : ShadePosition.custom,
      positionPercent: (s.position ?? 0).toDouble(),
      offered: const {ShadePosition.open, ShadePosition.closed},
      confirmation: _confirm(
        pending: s.pendingPosition != null || s.moving,
        failed: s.online.isEmpty ||
            failedRecently(r.tracker, [for (final d in s.shades) d.id], 'position') != null,
      ),
      onPositionChanged: enabled && s.online.isNotEmpty
          ? (p) => switch (p) {
                ShadePosition.open => r.run(s.to(100)),
                ShadePosition.closed => r.run(s.to(0)),
                _ => null,
              }
          : null,
    );
  }

  Widget? climateControl() {
    final c = climate;
    if (c == null) return null;
    final up = enabled ? c.stepped(1) : null;
    final down = enabled ? c.stepped(-1) : null;
    return ClimateControl(
      ambientC: c.ambientC,
      targetC: c.pendingTargetC ?? c.targetC,
      mode: ClimateMode.auto,
      confirmation: _confirm(
        pending: c.pendingTargetC != null || c.pendingPower,
        failed: !c.online || failedRecently(r.tracker, [c.device.id], 'temperature') != null,
      ),
      onIncrease: up == null ? null : () => r.run([up]),
      onDecrease: down == null ? null : () => r.run([down]),
      onModeChanged: null,
    );
  }

  Widget? audio() {
    final m = music;
    if (m == null) return null;
    return AudioControl(
      playing: m.pendingPlaying ?? m.playing,
      title: m.title,
      artist: m.artist,
      volumePercent: m.volume?.toDouble(),
      confirmation: _confirm(
        pending: m.pendingPlaying != null || m.pendingVolume != null,
        failed: !m.online || failedRecently(r.tracker, [m.device.id], 'media') != null,
      ),
      onPlayPause: enabled && m.online ? () => r.run([m.toggle()]) : null,
    );
  }

  /// The Experiences this space takes part in, as activation tiles (at most [max]).
  List<Widget> experienceTiles(int max) => [
        for (final e in experiences.take(max))
          ExperienceActivation(experience: e, spaceId: spaceId, residence: r, enabled: enabled)
      ];

  static List<Widget> present(Iterable<Widget?> ws) => [for (final w in ws) if (w != null) w];
}

class _Waiting extends StatelessWidget {
  final String roomName;
  final String message;
  final Widget? headerTrailing;
  const _Waiting({required this.roomName, required this.message, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    return Column(children: [
      RoomHeader(roomName: roomName, trailing: headerTrailing),
      Expanded(
        child: Center(
          child: Text(message,
              key: const ValueKey('panel-waiting'),
              style: text.body.copyWith(color: SupremeColorScheme.textSecondary),
              textAlign: TextAlign.center),
        ),
      ),
    ]);
  }
}

/// §Phase8-3 — 3-4": room identity, current atmosphere, ONE dominant action.
/// Deliberately does not attempt Lighting/Shades/Climate simultaneously —
/// "sequential/secondary interactions rather than compressing everything."
class _MicroExperience extends StatelessWidget {
  final String roomName;
  final _Room room;
  const _MicroExperience({required this.roomName, required this.room});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;
    final tiles = room.experienceTiles(1);

    return Padding(
      padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.md)),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(roomName, style: text.headline, textAlign: TextAlign.center),
          SizedBox(height: spacing.space(SupremeSpaceToken.xs)),
          EnvironmentalStateLine(summary: room.summary),
          if (tiles.isNotEmpty) ...[
            SizedBox(height: spacing.space(SupremeSpaceToken.lg)),
            tiles.first,
          ],
        ],
      ),
    );
  }
}

/// §Phase8-4 — 5-7": Lighting/Shades/Climate + Experience, large targets
/// preserved. Audio only "where space allows" — omitted here on purpose.
class _CompactExperience extends StatelessWidget {
  final String roomName;
  final _Room room;
  final Widget? headerTrailing;
  const _CompactExperience({required this.roomName, required this.room, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        RoomHeader(roomName: roomName, trailing: headerTrailing),
        Expanded(
          child: AdaptivePanel(children: _Room.present([
            room.lighting(),
            room.shadesControl(),
            room.climateControl(),
            ...room.experienceTiles(1),
          ])),
        ),
      ],
    );
  }
}

/// §Phase8-5 — 8-12": balanced, spacious composition — Lighting, Shades,
/// Climate, Audio, Experiences. "Spacious rather than card-heavy" — reuses
/// the same [AdaptivePanel] grid/stack composition as Mobile's Room screen
/// (shared foundation, §J), just with Audio and Experiences added.
class _StandardExperience extends StatelessWidget {
  final String roomName;
  final _Room room;
  final Widget? headerTrailing;
  const _StandardExperience({required this.roomName, required this.room, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        RoomHeader(roomName: roomName, trailing: headerTrailing),
        Expanded(
          child: AdaptivePanel(children: _Room.present([
            room.lighting(),
            room.shadesControl(),
            room.climateControl(),
            room.audio(),
            ...room.experienceTiles(2),
          ])),
        ),
      ],
    );
  }
}

/// §Phase8-6 — 13-20": additional space used intentionally — an atmosphere
/// panel (where the space's hero image renders once the asset is served, §8; the environmental
/// summary until then) alongside primary controls and Experiences.
class _ExpandedExperience extends StatelessWidget {
  final String roomName;
  final _Room room;
  final Widget? headerTrailing;
  const _ExpandedExperience({required this.roomName, required this.room, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    return Column(
      children: [
        RoomHeader(roomName: roomName, trailing: headerTrailing),
        Expanded(
          child: AdaptivePanel(children: [
            _AtmospherePanel(text: text, spacing: spacing, summary: room.summary),
            SingleChildScrollView(
              child: Column(children: _spaced(spacing, _Room.present([
                room.lighting(),
                room.climateControl(),
                ...room.experienceTiles(1),
              ]))),
            ),
          ]),
        ),
      ],
    );
  }
}

/// §Phase8-7 — 21-30"+: the full architectural composition — atmosphere,
/// Lighting+Climate, Shades+Audio, Experiences, each with real room to
/// breathe rather than an enlarged small-screen layout.
class _ImmersiveExperience extends StatelessWidget {
  final String roomName;
  final _Room room;
  final Widget? headerTrailing;
  const _ImmersiveExperience({required this.roomName, required this.room, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;
    final tiles = room.experienceTiles(2);

    return Column(
      children: [
        RoomHeader(roomName: roomName, trailing: headerTrailing),
        Expanded(
          child: AdaptivePanel(children: [
            _AtmospherePanel(text: text, spacing: spacing, summary: room.summary),
            // A plain, scrollable Column, not a nested AdaptivePanel: this
            // cell's composition was already decided by the OUTER
            // AdaptivePanel — AdaptivePanel reads the root viewport profile
            // (§Phase7-5), so nesting one inside another's cell makes it
            // re-derive the same root-level composition instead of
            // respecting the space this cell actually has, which is a real
            // layout bug, not a style choice (found in Phase 7 review).
            SingleChildScrollView(
              child: Column(children: _spaced(spacing, _Room.present([room.lighting(), room.climateControl()]))),
            ),
            SingleChildScrollView(
              child: Column(children: _spaced(spacing, _Room.present([room.shadesControl(), room.audio()]))),
            ),
            if (tiles.isNotEmpty)
              SupremeCard(
                child: Padding(
                  padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.lg)),
                  // Scrollable like the other cells: a fixed side-panel slot's available height
                  // is not guaranteed to fit every Experience tile at every aspect ratio, and
                  // scrolling is the correct fallback, not overflow.
                  child: SingleChildScrollView(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Experiences', style: text.headline),
                        SizedBox(height: spacing.space(SupremeSpaceToken.sm)),
                        ..._spaced(spacing, tiles, gap: SupremeSpaceToken.sm),
                      ],
                    ),
                  ),
                ),
              ),
          ]),
        ),
      ],
    );
  }
}

List<Widget> _spaced(SupremeSpacingResolver spacing, List<Widget> ws,
    {SupremeSpaceToken gap = SupremeSpaceToken.md}) {
  return [
    for (var i = 0; i < ws.length; i++) ...[
      if (i > 0) SizedBox(height: spacing.space(gap)),
      ws[i],
    ]
  ];
}

/// The atmosphere card: the environmental summary, derived from the space's device state.
class _AtmospherePanel extends StatelessWidget {
  final SupremeTextStyles text;
  final SupremeSpacingResolver spacing;
  final String summary;
  const _AtmospherePanel({required this.text, required this.spacing, required this.summary});

  @override
  Widget build(BuildContext context) {
    return SupremeCard(
      child: Padding(
        padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.lg)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Atmosphere', style: text.headline),
            SizedBox(height: spacing.space(SupremeSpaceToken.sm)),
            EnvironmentalStateLine(summary: summary),
          ],
        ),
      ),
    );
  }
}
