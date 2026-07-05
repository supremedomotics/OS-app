import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// A full-bleed, rounded room/home hero (§11.1, Ovio benchmark): a photographic
/// backdrop with a dark scrim and an environment summary overlaid — a status read on
/// the left ("Good · Air quality") and a metric on the right ("22.5° · Inside").
///
/// Theme-aware: with no [imageUrl] it falls back to a tasteful accent gradient that
/// reads cleanly in both Luxury Black and Luxury White.
class RoomHero extends StatelessWidget {
  const RoomHero({
    super.key,
    required this.title,
    this.subtitle,
    this.imageUrl,
    this.gradientColors,
    this.motif,
    this.statusLabel,
    this.statusValue,
    this.metricLabel,
    this.metricValue,
    this.height = 280,
    this.onTap,
  });

  final String title;
  final String? subtitle;
  final String? imageUrl;

  /// A designed room-type gradient (deep two-tone) used when there's no [imageUrl] — so a hero is
  /// never a flat accent block. Falls back to the accent gradient when null.
  final List<Color>? gradientColors;

  /// A soft motif emoji watermark shown on the gradient (no-photo) state.
  final String? motif;

  /// Left overlay — e.g. statusValue "Good" over statusLabel "Air quality".
  final String? statusValue;
  final String? statusLabel;

  /// Right overlay — e.g. metricValue "22.5°" over metricLabel "Inside".
  final String? metricValue;
  final String? metricLabel;

  final double height;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        child: SizedBox(
          height: height,
          width: double.infinity,
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (imageUrl != null && imageUrl!.isNotEmpty)
                Image.network(imageUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => _designed(scheme))
              else
                _designed(scheme),
              // Motif watermark on the designed (no-photo) state.
              if ((imageUrl == null || imageUrl!.isEmpty) && motif != null)
                Positioned(
                  top: 6,
                  right: 14,
                  child: Text(motif!, style: TextStyle(fontSize: height * 0.34, color: Colors.white.withValues(alpha: 0.12))),
                ),
              // Bottom scrim so overlay text stays legible over any image.
              const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.center,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Color(0x99000000)],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(AureonSpacing.lg),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisAlignment: MainAxisAlignment.spaceBetween,
                  children: [
                    Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title,
                            style: Theme.of(context).textTheme.titleLarge?.copyWith(color: Colors.white)),
                        if (subtitle != null)
                          Text(subtitle!, style: const TextStyle(color: Color(0xCCFFFFFF), fontSize: 13)),
                      ],
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        if (statusValue != null) _overlayStat(statusValue!, statusLabel),
                        const Spacer(),
                        if (metricValue != null) _overlayStat(metricValue!, metricLabel, alignEnd: true),
                      ],
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The designed background: the room-type [gradientColors] when provided, else the accent gradient.
  Widget _designed(ColorScheme scheme) {
    final colors = gradientColors != null && gradientColors!.length >= 2
        ? gradientColors!
        : [Color.alphaBlend(scheme.primary.withValues(alpha: 0.34), scheme.surface), scheme.surface];
    return DecoratedBox(
      decoration: BoxDecoration(
        gradient: LinearGradient(begin: Alignment.topRight, end: Alignment.bottomLeft, colors: colors),
      ),
    );
  }

  Widget _overlayStat(String value, String? label, {bool alignEnd = false}) => Column(
        crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w600)),
          if (label != null) Text(label, style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 14)),
        ],
      );
}
