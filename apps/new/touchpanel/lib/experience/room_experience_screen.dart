import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'experience_activation.dart';

/// The panel's normal, locked-scope room experience (§Phase7-7, §Phase8-2).
/// Branches on [AdaptiveProfile.panelMode] directly (five real tiers, not
/// three) because Phase 8 asks each tier to show a genuinely different set
/// of content, not just a different arrangement of the same content
/// (§Phase8-3..7).
///
/// State is mocked inline (clearly labeled) — live Hub/device wiring is
/// Phase 9+ (§43); a real build swaps this for the same `HomeRepository`-
/// shaped interface `apps/new/mobile` already uses. [connected] disables
/// every control when the Hub link is down (§Phase8-15) rather than letting
/// a homeowner issue a command that cannot execute.
class RoomExperienceScreen extends StatelessWidget {
  final String roomName;
  final bool connected;
  final Widget? headerTrailing;

  const RoomExperienceScreen({
    super.key,
    required this.roomName,
    this.connected = true,
    this.headerTrailing,
  });

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);

    return switch (profile.panelMode) {
      PanelPresentationMode.micro =>
        _MicroExperience(roomName: roomName, connected: connected),
      PanelPresentationMode.compact => _CompactExperience(
          roomName: roomName,
          connected: connected,
          headerTrailing: headerTrailing),
      PanelPresentationMode.standard => _StandardExperience(
          roomName: roomName,
          connected: connected,
          headerTrailing: headerTrailing),
      PanelPresentationMode.expanded => _ExpandedExperience(
          roomName: roomName,
          connected: connected,
          headerTrailing: headerTrailing),
      PanelPresentationMode.immersive => _ImmersiveExperience(
          roomName: roomName,
          connected: connected,
          headerTrailing: headerTrailing),
    };
  }
}

/// §Phase8-3 — 3-4": room identity, current atmosphere, ONE dominant action.
/// Deliberately does not attempt Lighting/Shades/Climate simultaneously —
/// "sequential/secondary interactions rather than compressing everything."
class _MicroExperience extends StatelessWidget {
  final String roomName;
  final bool connected;
  const _MicroExperience({required this.roomName, required this.connected});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    return Padding(
      padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.md)),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(roomName, style: text.headline, textAlign: TextAlign.center),
          SizedBox(height: spacing.space(SupremeSpaceToken.xs)),
          const EnvironmentalStateLine(summary: '72° · Warm'),
          SizedBox(height: spacing.space(SupremeSpaceToken.lg)),
          ExperienceActivation(name: 'Relax', enabled: connected),
        ],
      ),
    );
  }
}

/// §Phase8-4 — 5-7": Lighting/Shades/Climate + Experience, large targets
/// preserved. Audio only "where space allows" — omitted here on purpose.
class _CompactExperience extends StatelessWidget {
  final String roomName;
  final bool connected;
  final Widget? headerTrailing;
  const _CompactExperience(
      {required this.roomName, required this.connected, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        RoomHeader(
          roomName: roomName,
          overlay: const EnvironmentalOverlay(warmth: 0.4, brightness: 0.7),
          trailing: headerTrailing,
        ),
        Expanded(
          child: AdaptivePanel(children: [
            LightingControl(
              on: true,
              mood: LightingMood.warm,
              confirmation: ConfirmationState.confirmed,
              onToggle: connected ? (_) {} : null,
              onMoodChanged: connected ? (_) {} : null,
            ),
            ShadesControl(
              position: ShadePosition.relaxed,
              positionPercent: 60,
              confirmation: ConfirmationState.confirmed,
              onPositionChanged: connected ? (_) {} : null,
            ),
            ClimateControl(
              ambientC: 22,
              targetC: 22,
              mode: ClimateMode.auto,
              confirmation: ConfirmationState.confirmed,
              onIncrease: connected ? () {} : null,
              onDecrease: connected ? () {} : null,
              onModeChanged: connected ? (_) {} : null,
            ),
            ExperienceActivation(name: 'Relax', enabled: connected),
          ]),
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
  final bool connected;
  final Widget? headerTrailing;
  const _StandardExperience(
      {required this.roomName, required this.connected, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        RoomHeader(
          roomName: roomName,
          overlay: const EnvironmentalOverlay(warmth: 0.4, brightness: 0.7),
          trailing: headerTrailing,
        ),
        Expanded(
          child: AdaptivePanel(children: [
            LightingControl(
              on: true,
              mood: LightingMood.warm,
              confirmation: ConfirmationState.confirmed,
              onToggle: connected ? (_) {} : null,
              onMoodChanged: connected ? (_) {} : null,
            ),
            ShadesControl(
              position: ShadePosition.relaxed,
              positionPercent: 60,
              confirmation: ConfirmationState.confirmed,
              onPositionChanged: connected ? (_) {} : null,
            ),
            ClimateControl(
              ambientC: 22,
              targetC: 22,
              mode: ClimateMode.auto,
              confirmation: ConfirmationState.confirmed,
              onIncrease: connected ? () {} : null,
              onDecrease: connected ? () {} : null,
              onModeChanged: connected ? (_) {} : null,
            ),
            AudioControl(
              playing: false,
              title: null,
              artist: null,
              volumePercent: 40,
              confirmation: ConfirmationState.confirmed,
              onPlayPause: connected ? () {} : null,
            ),
            ExperienceActivation(name: 'Relax', enabled: connected),
            ExperienceActivation(name: 'Entertain', enabled: connected),
          ]),
        ),
      ],
    );
  }
}

/// §Phase8-6 — 13-20": additional space used intentionally — an atmosphere
/// panel (where hero imagery will render, §8; an elegant non-image
/// fallback until then) alongside primary controls and Experiences.
class _ExpandedExperience extends StatelessWidget {
  final String roomName;
  final bool connected;
  final Widget? headerTrailing;
  const _ExpandedExperience(
      {required this.roomName, required this.connected, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    return Column(
      children: [
        RoomHeader(
          roomName: roomName,
          overlay: const EnvironmentalOverlay(warmth: 0.4, brightness: 0.7),
          trailing: headerTrailing,
        ),
        Expanded(
          child: AdaptivePanel(children: [
            _AtmospherePanel(text: text, spacing: spacing),
            SingleChildScrollView(
              child: Column(children: [
                LightingControl(
                  on: true,
                  mood: LightingMood.warm,
                  confirmation: ConfirmationState.confirmed,
                  onToggle: connected ? (_) {} : null,
                  onMoodChanged: connected ? (_) {} : null,
                ),
                SizedBox(height: spacing.space(SupremeSpaceToken.md)),
                ClimateControl(
                  ambientC: 22,
                  targetC: 22,
                  mode: ClimateMode.auto,
                  confirmation: ConfirmationState.confirmed,
                  onIncrease: connected ? () {} : null,
                  onDecrease: connected ? () {} : null,
                  onModeChanged: connected ? (_) {} : null,
                ),
                SizedBox(height: spacing.space(SupremeSpaceToken.md)),
                ExperienceActivation(name: 'Relax', enabled: connected),
              ]),
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
  final bool connected;
  final Widget? headerTrailing;
  const _ImmersiveExperience(
      {required this.roomName, required this.connected, this.headerTrailing});

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    return Column(
      children: [
        RoomHeader(
          roomName: roomName,
          overlay: const EnvironmentalOverlay(warmth: 0.4, brightness: 0.7),
          trailing: headerTrailing,
        ),
        Expanded(
          child: AdaptivePanel(children: [
            _AtmospherePanel(text: text, spacing: spacing),
            // A plain, scrollable Column, not a nested AdaptivePanel: this
            // cell's composition was already decided by the OUTER
            // AdaptivePanel — AdaptivePanel reads the root viewport profile
            // (§Phase7-5), so nesting one inside another's cell makes it
            // re-derive the same root-level composition instead of
            // respecting the space this cell actually has, which is a real
            // layout bug, not a style choice (found in Phase 7 review).
            SingleChildScrollView(
              child: Column(children: [
                LightingControl(
                  on: true,
                  mood: LightingMood.warm,
                  confirmation: ConfirmationState.confirmed,
                  onToggle: connected ? (_) {} : null,
                  onMoodChanged: connected ? (_) {} : null,
                ),
                SizedBox(height: spacing.space(SupremeSpaceToken.md)),
                ClimateControl(
                  ambientC: 22,
                  targetC: 22,
                  mode: ClimateMode.auto,
                  confirmation: ConfirmationState.confirmed,
                  onIncrease: connected ? () {} : null,
                  onDecrease: connected ? () {} : null,
                  onModeChanged: connected ? (_) {} : null,
                ),
              ]),
            ),
            SingleChildScrollView(
              child: Column(children: [
                ShadesControl(
                  position: ShadePosition.relaxed,
                  positionPercent: 60,
                  confirmation: ConfirmationState.confirmed,
                  onPositionChanged: connected ? (_) {} : null,
                ),
                SizedBox(height: spacing.space(SupremeSpaceToken.md)),
                AudioControl(
                  playing: false,
                  title: null,
                  artist: null,
                  volumePercent: 40,
                  confirmation: ConfirmationState.confirmed,
                  onPlayPause: connected ? () {} : null,
                ),
              ]),
            ),
            SupremeCard(
              child: Padding(
                padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.lg)),
                // Scrollable like the other two immersive cells: a fixed
                // side-panel slot's available height is not guaranteed to
                // fit every Experience tile at every aspect ratio, and
                // scrolling is the correct fallback, not overflow.
                child: SingleChildScrollView(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('Experiences', style: text.headline),
                      SizedBox(height: spacing.space(SupremeSpaceToken.sm)),
                      ExperienceActivation(name: 'Relax', enabled: connected),
                      SizedBox(height: spacing.space(SupremeSpaceToken.sm)),
                      ExperienceActivation(
                          name: 'Entertain', enabled: connected),
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

/// Shared "where architectural imagery will render" panel (§Phase8-8) — an
/// elegant non-image fallback: no photo asset pipeline exists yet, so this
/// is the environmental-state summary on its own card rather than a blank
/// or placeholder-looking box.
class _AtmospherePanel extends StatelessWidget {
  final SupremeTextStyles text;
  final SupremeSpacingResolver spacing;
  const _AtmospherePanel({required this.text, required this.spacing});

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
            const EnvironmentalStateLine(
                summary: '72° · Warm · Shades relaxed'),
          ],
        ),
      ),
    );
  }
}
