import 'package:flutter/material.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

import '../adaptive/adaptive_scope.dart';
import '../theme/supreme_colors.dart';
import '../theme/supreme_theme.dart';
import 'supreme_card.dart';

/// Shared shell every domain control uses: a title, a confirmation-aware
/// state line (§31 — requested vs confirmed, never claims success from a
/// sent command alone), and the control's own body.
class _DomainControlShell extends StatelessWidget {
  final String title;
  final IconData icon;
  final String stateLabel;
  final ConfirmationState confirmation;
  final Widget body;

  const _DomainControlShell({
    required this.title,
    required this.icon,
    required this.stateLabel,
    required this.confirmation,
    required this.body,
  });

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final text = SupremeTextStyles.resolve(profile.density);
    final spacing = profile.spacing;

    final displayedState = switch (confirmation) {
      ConfirmationState.requested => 'Applying…',
      ConfirmationState.confirmed => stateLabel,
      ConfirmationState.failed => 'Unavailable',
    };

    return SupremeCard(
      child: Padding(
        padding: EdgeInsets.all(spacing.space(SupremeSpaceToken.md)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              Icon(icon,
                  color: SupremeColorScheme.gold500,
                  size: spacing.iconSize(SupremeIconSizeToken.md)),
              SizedBox(width: spacing.space(SupremeSpaceToken.sm)),
              Expanded(child: Text(title, style: text.headline)),
            ]),
            SizedBox(height: spacing.space(SupremeSpaceToken.xs)),
            Semantics(
              label: '$title: $displayedState',
              liveRegion: confirmation == ConfirmationState.requested,
              child: Text(displayedState, style: text.label),
            ),
            SizedBox(height: spacing.space(SupremeSpaceToken.sm)),
            body,
          ],
        ),
      ),
    );
  }
}

/// Environmental-language lighting control (§19) — mood, not raw Kelvin.
/// [onToggle]/[onMoodChanged] are nullable: passing `null` (rather than a
/// no-op) is how a caller genuinely disables the control — e.g. while the
/// Hub connection is down (§Phase8-15) — so Flutter's own disabled-state
/// styling (greyed switch/chips) applies, not just a silently-ignored tap.
class LightingControl extends StatelessWidget {
  final bool on;
  final LightingMood mood;
  final ConfirmationState confirmation;
  final ValueChanged<bool>? onToggle;
  final ValueChanged<LightingMood>? onMoodChanged;

  const LightingControl({
    super.key,
    required this.on,
    required this.mood,
    required this.confirmation,
    required this.onToggle,
    required this.onMoodChanged,
  });

  static const _moodLabels = {
    LightingMood.candle: 'Candle',
    LightingMood.warm: 'Warm',
    LightingMood.neutral: 'Neutral',
    LightingMood.cool: 'Cool',
    LightingMood.custom: 'Custom',
  };

  @override
  Widget build(BuildContext context) {
    return _DomainControlShell(
      title: 'Lighting',
      icon: Icons.wb_incandescent_outlined,
      stateLabel: on ? _moodLabels[mood]! : 'Off',
      confirmation: confirmation,
      body: Row(children: [
        Semantics(
          label: on ? 'Turn lighting off' : 'Turn lighting on',
          child: Switch(value: on, onChanged: onToggle),
        ),
        Expanded(
          child: Wrap(
            spacing: 8,
            children: [
              for (final entry in _moodLabels.entries)
                if (entry.key != LightingMood.custom)
                  ChoiceChip(
                    label: Text(entry.value),
                    selected: mood == entry.key,
                    onSelected: on && onMoodChanged != null
                        ? (_) => onMoodChanged!(entry.key)
                        : null,
                  ),
            ],
          ),
        ),
      ]),
    );
  }
}

/// Physical-language shades control (§20) — Open/Relaxed/Closed + position.
class ShadesControl extends StatelessWidget {
  final ShadePosition position;
  final double positionPercent; // 0..100, 100 = fully open
  final ConfirmationState confirmation;
  final ValueChanged<ShadePosition>? onPositionChanged;

  const ShadesControl({
    super.key,
    required this.position,
    required this.positionPercent,
    required this.confirmation,
    required this.onPositionChanged,
  });

  static const _labels = {
    ShadePosition.open: 'Open',
    ShadePosition.relaxed: 'Relaxed',
    ShadePosition.closed: 'Closed',
    ShadePosition.custom: 'Custom',
  };

  @override
  Widget build(BuildContext context) {
    return _DomainControlShell(
      title: 'Shades',
      icon: Icons.blinds_outlined,
      stateLabel: _labels[position]!,
      confirmation: confirmation,
      body: Column(children: [
        Wrap(
          spacing: 8,
          children: [
            for (final entry in _labels.entries)
              if (entry.key != ShadePosition.custom)
                ChoiceChip(
                  label: Text(entry.value),
                  selected: position == entry.key,
                  onSelected: onPositionChanged == null
                      ? null
                      : (_) => onPositionChanged!(entry.key),
                ),
          ],
        ),
        Semantics(
          label: 'Shade position, $positionPercent percent open',
          slider: true,
          child:
              Slider(value: positionPercent, min: 0, max: 100, onChanged: null),
        ),
      ]),
    );
  }
}

/// Climate control (§21) — current temperature, comfort state, +/-.
class ClimateControl extends StatelessWidget {
  final double ambientC;
  final double? targetC;
  final ClimateMode mode;
  final ConfirmationState confirmation;
  final VoidCallback? onIncrease;
  final VoidCallback? onDecrease;
  final ValueChanged<ClimateMode>? onModeChanged;

  const ClimateControl({
    super.key,
    required this.ambientC,
    required this.targetC,
    required this.mode,
    required this.confirmation,
    required this.onIncrease,
    required this.onDecrease,
    required this.onModeChanged,
  });

  static const _modeLabels = {
    ClimateMode.auto: 'Auto',
    ClimateMode.cooling: 'Cooling',
    ClimateMode.heating: 'Heating',
    ClimateMode.off: 'Off',
  };

  @override
  Widget build(BuildContext context) {
    return _DomainControlShell(
      title: 'Climate',
      icon: Icons.thermostat_outlined,
      stateLabel:
          targetC != null ? '${targetC!.round()}°' : '${ambientC.round()}°',
      confirmation: confirmation,
      // Wrap, not Row+Spacer: this control renders inside cards as narrow as
      // a Touch Panel's side-panel column (§Phase7-8), where a fixed Row
      // with a Spacer genuinely overflows — Wrap lets it flow to a second
      // line instead of clipping content.
      body: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Semantics(
            button: true,
            label: 'Decrease temperature',
            child: IconButton(
                onPressed: onDecrease, icon: const Icon(Icons.remove)),
          ),
          Text('${(targetC ?? ambientC).round()}°'),
          Semantics(
            button: true,
            label: 'Increase temperature',
            child:
                IconButton(onPressed: onIncrease, icon: const Icon(Icons.add)),
          ),
          // Bounded width + isExpanded: a DropdownButton otherwise demands
          // its full intrinsic content width regardless of the Wrap it
          // sits in, which genuinely overflows in a narrow side-panel
          // column (§Phase7-8) — bounding it lets the label ellipsize
          // instead of overflowing the row it's in.
          SizedBox(
            width: 96,
            child: DropdownButtonHideUnderline(
              child: DropdownButton<ClimateMode>(
                isExpanded: true,
                isDense: true,
                value: mode,
                onChanged: onModeChanged == null
                    ? null
                    : (m) => m == null ? null : onModeChanged!(m),
                items: [
                  for (final m in [
                    ClimateMode.auto,
                    ClimateMode.cooling,
                    ClimateMode.heating
                  ])
                    DropdownMenuItem(
                      value: m,
                      child: Text(_modeLabels[m]!,
                          overflow: TextOverflow.ellipsis),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Media-language audio control (§22).
class AudioControl extends StatelessWidget {
  final bool playing;
  final String? title;
  final String? artist;
  final double volumePercent;
  final ConfirmationState confirmation;
  final VoidCallback? onPlayPause;

  const AudioControl({
    super.key,
    required this.playing,
    required this.title,
    required this.artist,
    required this.volumePercent,
    required this.confirmation,
    required this.onPlayPause,
  });

  @override
  Widget build(BuildContext context) {
    return _DomainControlShell(
      title: 'Audio',
      icon: Icons.graphic_eq,
      stateLabel: title ?? (playing ? 'Playing' : 'Paused'),
      confirmation: confirmation,
      // Wrap, not Row: a fixed Row (icon + artist + a fixed-width slider)
      // genuinely overflows in a narrow side-panel column (§Phase7-8) even
      // with no artist text at all — the icon button plus the 96px slider
      // alone exceed some real column widths. Wrap lets the slider drop to
      // its own line instead of overflowing.
      body: Wrap(
        crossAxisAlignment: WrapCrossAlignment.center,
        spacing: 8,
        children: [
          Semantics(
            button: true,
            label: playing ? 'Pause' : 'Play',
            child: IconButton(
              onPressed: onPlayPause,
              icon: Icon(
                  playing ? Icons.pause_circle_filled : Icons.play_circle_fill),
            ),
          ),
          if (artist != null)
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 140),
              child: Text(artist!, overflow: TextOverflow.ellipsis),
            ),
          Semantics(
            label: 'Volume, $volumePercent percent',
            slider: true,
            child: SizedBox(
              width: 96,
              child: Slider(
                  value: volumePercent, min: 0, max: 100, onChanged: null),
            ),
          ),
        ],
      ),
    );
  }
}
