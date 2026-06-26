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
                Image.network(imageUrl!, fit: BoxFit.cover, errorBuilder: (_, __, ___) => _gradient(scheme))
              else
                _gradient(scheme),
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

  Widget _gradient(ColorScheme scheme) => DecoratedBox(
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              Color.alphaBlend(scheme.primary.withValues(alpha: 0.34), scheme.surface),
              scheme.surface,
            ],
          ),
        ),
      );

  Widget _overlayStat(String value, String? label, {bool alignEnd = false}) => Column(
        crossAxisAlignment: alignEnd ? CrossAxisAlignment.end : CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(value, style: const TextStyle(color: Colors.white, fontSize: 22, fontWeight: FontWeight.w600)),
          if (label != null) Text(label, style: const TextStyle(color: Color(0xB3FFFFFF), fontSize: 14)),
        ],
      );
}
