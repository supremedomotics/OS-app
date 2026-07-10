import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Media transport card (§11.1): artwork, title/artist, progress/duration with seek,
/// transport controls, shuffle/repeat toggles, a volume slider, and (when the device
/// advertises any) a source/input picker. Shuffle/repeat/progress/inputs are all
/// optional — a device whose protocol doesn't report them (e.g. a Denon Telnet zone
/// with no Net/USB source active) simply omits that row rather than faking one.
class MediaCard extends StatelessWidget {
  const MediaCard({
    super.key,
    required this.title,
    required this.artist,
    required this.playing,
    required this.volume,
    required this.onPlayPause,
    required this.onNext,
    required this.onPrevious,
    required this.onVolume,
    this.artworkUrl,
    this.durationSec,
    this.positionSec,
    this.onSeek,
    this.shuffle,
    this.onShuffle,
    this.repeat,
    this.onRepeat,
    this.source,
    this.inputs = const [],
    this.onSelectInput,
  });

  final String? title;
  final String? artist;
  final bool playing;
  final double volume; // 0..1
  final String? artworkUrl;
  final VoidCallback onPlayPause;
  final VoidCallback onNext;
  final VoidCallback onPrevious;
  final ValueChanged<double> onVolume;

  /// Track position/duration in seconds. Null (either) hides the progress row —
  /// most true for live/streaming sources with no known length.
  final double? durationSec;
  final double? positionSec;
  final ValueChanged<double>? onSeek;

  /// Null hides the toggle — the device's protocol doesn't report shuffle/repeat at
  /// all (verified per-protocol, never assumed).
  final bool? shuffle;
  final VoidCallback? onShuffle;
  final String? repeat; // "off" | "all" | "one"
  final VoidCallback? onRepeat;

  /// Currently-selected input id + the device's own advertised input list (Universal
  /// AVR Framework §7 — dynamic capability detection, never a hardcoded brand list).
  final String? source;
  final List<({String id, String label})> inputs;
  final ValueChanged<String>? onSelectInput;

  String _formatTime(double sec) {
    final s = sec.round().clamp(0, 359999);
    final m = s ~/ 60;
    final r = s % 60;
    return '$m:${r.toString().padLeft(2, '0')}';
  }

  void _pickInput(BuildContext context) {
    showModalBottomSheet<void>(
      context: context,
      builder: (ctx) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final input in inputs)
              ListTile(
                title: Text(input.label),
                trailing: source == input.id
                    ? const Icon(Icons.check, color: AureonGold.c500)
                    : null,
                onTap: () {
                  Navigator.of(ctx).pop();
                  onSelectInput?.call(input.id);
                },
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final matchingInputs = inputs.where((i) => i.id == source);
    final sourceLabel =
        matchingInputs.isEmpty ? source : matchingInputs.first.label;
    return Container(
      padding: const EdgeInsets.all(AureonSpacing.lg),
      decoration: BoxDecoration(
        color: AureonBase.surfaceRaised,
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        border: Border.all(color: AureonBase.hairline),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (inputs.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
              child: GestureDetector(
                onTap: () => _pickInput(context),
                child: Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(sourceLabel ?? 'Speakers',
                        style: Theme.of(context).textTheme.labelMedium),
                    const Icon(Icons.expand_more,
                        size: 18, color: AureonText.muted),
                  ],
                ),
              ),
            ),
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(AureonRadius.sm),
                child: artworkUrl != null
                    ? Image.network(artworkUrl!,
                        width: 64, height: 64, fit: BoxFit.cover)
                    : Container(
                        width: 64,
                        height: 64,
                        color: AureonBase.surfaceOverlay,
                        child: const Icon(Icons.music_note,
                            color: AureonText.muted),
                      ),
              ),
              const SizedBox(width: AureonSpacing.md),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title ?? 'Nothing playing',
                        style: Theme.of(context).textTheme.bodyLarge,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis),
                    if (artist != null)
                      Text(artist!,
                          style: Theme.of(context).textTheme.labelMedium),
                  ],
                ),
              ),
            ],
          ),
          if (durationSec != null && durationSec! > 0) ...[
            const SizedBox(height: AureonSpacing.sm),
            Slider(
              value: (positionSec ?? 0).clamp(0, durationSec!),
              max: durationSec!,
              activeColor: AureonGold.c500,
              onChanged: onSeek,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 4),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(_formatTime(positionSec ?? 0),
                      style: Theme.of(context).textTheme.labelSmall),
                  Text(_formatTime(durationSec!),
                      style: Theme.of(context).textTheme.labelSmall),
                ],
              ),
            ),
          ],
          const SizedBox(height: AureonSpacing.md),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              IconButton(
                  onPressed: onPrevious, icon: const Icon(Icons.skip_previous)),
              IconButton(
                iconSize: 40,
                color: AureonGold.c400,
                onPressed: onPlayPause,
                icon: Icon(playing ? Icons.pause_circle : Icons.play_circle),
              ),
              IconButton(onPressed: onNext, icon: const Icon(Icons.skip_next)),
            ],
          ),
          if (shuffle != null || repeat != null) ...[
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                if (shuffle != null)
                  IconButton(
                    onPressed: onShuffle,
                    icon: Icon(Icons.shuffle,
                        color: shuffle! ? AureonGold.c500 : AureonText.muted),
                  ),
                if (repeat != null)
                  IconButton(
                    onPressed: onRepeat,
                    icon: Icon(
                      repeat == 'one' ? Icons.repeat_one : Icons.repeat,
                      color: repeat != 'off' ? AureonGold.c500 : AureonText.muted,
                    ),
                  ),
              ],
            ),
          ],
          Row(
            children: [
              const Icon(Icons.volume_down, color: AureonText.muted),
              Expanded(
                child: Slider(
                  value: volume.clamp(0, 1),
                  activeColor: AureonGold.c500,
                  onChanged: onVolume,
                ),
              ),
              const Icon(Icons.volume_up, color: AureonText.muted),
            ],
          ),
        ],
      ),
    );
  }
}
