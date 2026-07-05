import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Media transport card (§11.1): artwork, title/artist, transport controls, and a
/// volume slider. Source badge + queue depth are added with the full media model.
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

  @override
  Widget build(BuildContext context) {
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
