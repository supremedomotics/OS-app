import 'dart:async';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';

/// The AVR/Receiver console (§ AVR Detail Page) — a rich, capability-driven control
/// surface for any `media` device. Every widget here is driven entirely by the
/// device's own AudioCapabilityConfig (`Device.mediaInputs`/`mediaSoundModes`/
/// `mediaAdvancedControls`) and live MediaState — nothing is hardcoded per brand. A
/// device that declares no inputs/sound modes/advanced controls simply renders a
/// console with those sections absent. Shared between the phone bottom sheet
/// ([showDeviceSheet]) and the tablet full-page console (AvrConsoleScreen) so both
/// platforms stay in lockstep with the same real data and the same commands.

String fmtTime(num sec) {
  final s = sec.round().clamp(0, 1 << 30);
  return '${s ~/ 60}:${(s % 60).toString().padLeft(2, '0')}';
}

/// Loose, unvalidated icon hint → glyph (matches AvrInput.type's "display hint only"
/// contract on the wire side — never a hard requirement).
IconData inputIcon(String? type) {
  switch (type) {
    case 'hdmi': return Icons.cast_connected;
    case 'optical': return Icons.settings_input_component;
    case 'analog': return Icons.cable;
    case 'tuner': return Icons.radio;
    case 'usb': return Icons.usb;
    case 'bluetooth': return Icons.bluetooth;
    case 'streaming': return Icons.cloud_outlined;
    case 'network': return Icons.dns_outlined;
    default: return Icons.music_note;
  }
}

/// Sibling zone devices of the SAME physical unit (§ Zone selector) — computed from
/// discovery-captured network metadata (`Device.network`), not a driver-level runtime
/// zone switch (no protocol here has one). Empty when this device has no network info
/// or no sibling shares it — callers hide the Zone control entirely then.
List<Device> zoneSiblings(Device device, List<Device> allDevices) {
  final net = device.network;
  final key = net?.ip ?? net?.host;
  if (key == null) return const [];
  return allDevices.where((d) {
    if (d.id == device.id) return false;
    if (!d.capabilities.contains('media')) return false;
    final dn = d.network;
    return (dn?.ip ?? dn?.host) == key;
  }).toList();
}

/// Loose, unvalidated icon hint for a listening-mode/sound-program name — matches common
/// substrings across brands' DSP vocabularies so hardware-style mode buttons get a
/// sensible glyph without ever hardcoding a specific brand's mode list.
IconData soundModeIcon(String label) {
  final l = label.toLowerCase();
  if (l.contains('movie') || l.contains('cinema') || l.contains('theater')) return Icons.theaters_outlined;
  if (l.contains('music') || l.contains('concert')) return Icons.music_note_outlined;
  if (l.contains('game')) return Icons.sports_esports_outlined;
  if (l.contains('direct') || l.contains('pure') || l.contains('straight')) return Icons.radio_button_unchecked;
  if (l.contains('dolby') || l.contains('dts') || l.contains('atmos') || l.contains('surround')) return Icons.surround_sound_outlined;
  if (l.contains('stereo')) return Icons.equalizer;
  if (l.contains('night')) return Icons.bedtime_outlined;
  return Icons.tune;
}

typedef RoomStatusItem = ({IconData icon, String label, bool good});

/// Whole-Home Intelligence (§ Entertainment Status) — a slim, contextual read of the
/// room this receiver lives in, built entirely from real sibling devices' live state:
/// covers/curtains, lights, climate, plus the AVR's own status/format. A device this
/// home doesn't have in the room simply contributes no pill — never a fixed checklist.
List<RoomStatusItem> roomStatus(Device device, Map<String, dynamic> media, List<Device> roomDevices) {
  final items = <RoomStatusItem>[];
  final mates = roomDevices.where((d) => d.id != device.id && !d.capabilities.contains('media')).toList();

  final covers = mates.where((d) => d.capabilities.contains('position')).toList();
  if (covers.isNotEmpty) {
    final positions = covers.map((d) => ((d.state['position'] as Map<String, dynamic>?)?['position'] as num?)?.toDouble() ?? 0).toList();
    final avg = positions.reduce((a, b) => a + b) / positions.length;
    items.add(avg < 15 ? (icon: Icons.curtains_closed_outlined, label: 'Curtains Closed', good: true) : (icon: Icons.curtains_outlined, label: 'Curtains ${avg.round()}% Open', good: false));
  }

  final lights = mates.where((d) => (d.capabilities.contains('brightness') || d.capabilities.contains('onoff')) && !d.capabilities.contains('position')).toList();
  if (lights.isNotEmpty) {
    final on = lights.where((d) {
      final b = d.state['brightness'] as Map<String, dynamic>?;
      final o = d.state['onoff'] as Map<String, dynamic>?;
      return (b?['on'] ?? o?['on']) == true;
    }).toList();
    if (on.isEmpty) {
      items.add((icon: Icons.lightbulb_outline, label: 'Lights Off', good: true));
    } else {
      final levels = on.map((d) => (d.state['brightness'] as Map<String, dynamic>?)?['level']).whereType<num>().toList();
      final avg = levels.isNotEmpty ? (levels.reduce((a, b) => a + b) / levels.length).round() : null;
      items.add((icon: Icons.lightbulb_outline, label: avg != null ? 'Lights $avg%' : '${on.length} Light${on.length == 1 ? '' : 's'} On', good: avg != null && avg <= 25));
    }
  }

  final climate = mates.where((d) => d.capabilities.contains('temperature')).firstOrNull;
  if (climate != null) {
    final ambient = (climate.state['temperature'] as Map<String, dynamic>?)?['ambientC'];
    if (ambient is num) items.add((icon: Icons.thermostat_outlined, label: '${ambient.toStringAsFixed(0)}°C', good: true));
  }

  items.add((icon: Icons.podcasts, label: device.status == 'online' ? 'AVR Online' : 'AVR Offline', good: device.status == 'online'));

  final soundMode = media['advanced'] is Map ? (media['advanced'] as Map)['soundMode'] as String? : null;
  if (soundMode != null) items.add((icon: soundModeIcon(soundMode), label: soundMode, good: true));

  return items;
}

/// A slim, elegant context strip — never a checklist. Read-only (this reflects other
/// devices' state; changing them belongs on their own cards).
class EntertainmentStatus extends StatelessWidget {
  const EntertainmentStatus({super.key, required this.items});
  final List<RoomStatusItem> items;

  @override
  Widget build(BuildContext context) {
    if (items.isEmpty) return const SizedBox.shrink();
    return Wrap(spacing: 8, runSpacing: 8, children: [
      for (final it in items)
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AureonRadius.pill),
            color: AureonBase.surfaceRaised.withValues(alpha: 0.7),
            border: Border.all(color: it.good ? AureonStatus.good.withValues(alpha: 0.3) : AureonBase.hairline),
          ),
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(it.icon, size: 13, color: it.good ? AureonStatus.good : AureonText.secondary),
            const SizedBox(width: 6),
            Text(it.label, style: TextStyle(fontSize: 11.5, color: it.good ? AureonStatus.good : AureonText.secondary)),
          ]),
        ),
    ]);
  }
}

/// A layered surface — a subtle top-lit gradient + soft ambient shadow — used for every
/// grouped section (now playing, selectors, source list, quick actions) so the console
/// reads as sculpted panels rather than flat rectangles.
class AvrCard extends StatelessWidget {
  const AvrCard({super.key, required this.child, this.padding = const EdgeInsets.all(AureonSpacing.md + 2)});
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: padding,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(AureonRadius.lg + 2),
        gradient: LinearGradient(
          begin: Alignment.topCenter, end: Alignment.bottomCenter,
          colors: [Color.lerp(AureonBase.surfaceRaised, Colors.white, 0.02)!, AureonBase.surfaceRaised],
        ),
        border: Border.all(color: AureonBase.hairline),
        boxShadow: [
          BoxShadow(color: Colors.black.withValues(alpha: 0.35), blurRadius: 28, offset: const Offset(0, 16)),
          BoxShadow(color: Colors.white.withValues(alpha: 0.03), blurRadius: 0, spreadRadius: 0.5),
        ],
      ),
      child: child,
    );
  }
}

/// Sample a real artwork image's dominant hue client-side (a downscaled pixel read, no
/// extra network round-trip) so the ambient halo can carry a whisper of the actual cover
/// art color instead of a fixed gold — the way a premium player's now-playing glow does.
/// Returns null (→ the console's own gold) for art-less devices or any decode failure.
Future<Color?> extractDominantColor(String url) async {
  try {
    final stream = NetworkImage(url).resolve(const ImageConfiguration());
    final completer = Completer<ui.Image>();
    late ImageStreamListener listener;
    listener = ImageStreamListener(
      (info, _) { completer.complete(info.image); stream.removeListener(listener); },
      onError: (err, st) { completer.completeError(err); stream.removeListener(listener); },
    );
    stream.addListener(listener);
    final image = await completer.future.timeout(const Duration(seconds: 5));
    final bytes = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    if (bytes == null) return null;
    final data = bytes.buffer.asUint8List();
    int r = 0, g = 0, b = 0, n = 0;
    for (var i = 0; i + 3 < data.length; i += 4 * 37) {
      final a = data[i + 3];
      if (a < 32) continue;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
    if (n == 0) return null;
    r ~/= n; g ~/= n; b ~/= n;
    final maxc = math.max(r, math.max(g, b));
    if (maxc < 90 && maxc > 0) {
      final boost = 90 / maxc;
      r = (r * boost).clamp(0, 255).round();
      g = (g * boost).clamp(0, 255).round();
      b = (b * boost).clamp(0, 255).round();
    }
    return Color.fromARGB(255, r, g, b);
  } catch (_) {
    return null;
  }
}

// ── Ambient halo (§ SupremeOS Signature) — a quiet, always-present glow that breathes
// with playback and carries a whisper of the artwork's own sampled color; a few soft
// drifting motes read as flowing light, never a "confetti" effect. ────────────────────
class AvrAmbientHalo extends StatefulWidget {
  const AvrAmbientHalo({super.key, required this.playing, this.tint});
  final bool playing;
  final Color? tint;

  @override
  State<AvrAmbientHalo> createState() => _AvrAmbientHaloState();
}

class _AvrAmbientHaloState extends State<AvrAmbientHalo> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 7000))..repeat(reverse: true);
  late final AnimationController _particles = AnimationController(vsync: this, duration: const Duration(milliseconds: 9000))..repeat();

  @override
  void dispose() {
    _c.dispose();
    _particles.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tint = widget.tint ?? AureonGold.c400;
    final tintLight = Color.lerp(tint, Colors.white, 0.2)!;
    return AnimatedBuilder(
      animation: Listenable.merge([_c, _particles]),
      builder: (context, _) {
        final t = widget.playing ? Curves.easeInOut.transform(_c.value) : 0.0;
        final baseAlpha = widget.playing ? 0.32 : 0.07;
        return Stack(alignment: Alignment.center, children: [
          Container(
            width: 260 + t * 30, height: 260 + t * 30,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [tint.withValues(alpha: baseAlpha + t * 0.15), tint.withValues(alpha: 0)]),
            ),
          ),
          Container(
            width: 196 + t * 16, height: 196 + t * 16,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [tintLight.withValues(alpha: (baseAlpha + t * 0.18) * 0.9), tintLight.withValues(alpha: 0)]),
            ),
          ),
          if (widget.playing) ..._particlePositions.map((p) => _particle(p, tintLight)),
        ]);
      },
    );
  }

  static const _particlePositions = [Offset(-70, -80), Offset(90, 60), Offset(75, -85), Offset(-85, 75)];

  Widget _particle(Offset base, Color tint) {
    final phase = (_particles.value + base.dx / 200) % 1.0;
    final wave = math.sin(phase * 2 * math.pi);
    final opacity = (0.15 + 0.35 * (0.5 + 0.5 * wave)).clamp(0.0, 0.6);
    return Transform.translate(
      offset: Offset(base.dx + wave * 6, base.dy - wave * 10),
      child: Container(
        width: 5, height: 5,
        decoration: BoxDecoration(shape: BoxShape.circle, color: tint.withValues(alpha: opacity), boxShadow: [BoxShadow(color: tint.withValues(alpha: opacity * 0.8), blurRadius: 6)]),
      ),
    );
  }
}

class AvrAlbumArt extends StatefulWidget {
  const AvrAlbumArt({super.key, required this.url, required this.name, required this.playing, this.size = 216});
  final String? url;
  final String name;
  final bool playing;
  final double size;

  @override
  State<AvrAlbumArt> createState() => _AvrAlbumArtState();
}

class _AvrAlbumArtState extends State<AvrAlbumArt> {
  Color? _tint;

  @override
  void initState() {
    super.initState();
    _loadTint();
  }

  @override
  void didUpdateWidget(covariant AvrAlbumArt old) {
    super.didUpdateWidget(old);
    if (old.url != widget.url) _loadTint();
  }

  void _loadTint() {
    final url = widget.url;
    if (url == null) { setState(() => _tint = null); return; }
    extractDominantColor(url).then((c) { if (mounted) setState(() => _tint = c); });
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    return SizedBox(
      width: size + 40, height: size + 40,
      child: Stack(alignment: Alignment.center, children: [
        AvrAmbientHalo(playing: widget.playing, tint: _tint),
        // Floating depth (§ Album Art): a slow, minute drift so the art reads as resting
        // just above the card, not printed on it. Pauses when idle.
        _FloatingArt(
          playing: widget.playing,
          child: Container(
            width: size, height: size,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              boxShadow: [
                BoxShadow(color: Colors.black.withValues(alpha: 0.5), blurRadius: 32, offset: const Offset(0, 18)),
                BoxShadow(color: Colors.white.withValues(alpha: 0.05), blurRadius: 0, spreadRadius: 0.5),
              ],
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              child: widget.url != null
                  ? Image.network(widget.url!, width: size, height: size, fit: BoxFit.cover)
                  : Container(
                      width: size, height: size,
                      decoration: BoxDecoration(
                        gradient: LinearGradient(
                          begin: Alignment.topLeft, end: Alignment.bottomRight,
                          colors: [AureonBase.surface, Color.lerp(AureonBase.surface, Colors.black, 0.25)!],
                        ),
                      ),
                      alignment: Alignment.center,
                      child: Text(widget.name.isNotEmpty ? widget.name[0].toUpperCase() : '♪', style: TextStyle(fontSize: size * 0.30, fontWeight: FontWeight.w600, color: AureonGold.c400)),
                    ),
            ),
          ),
        ),
      ]),
    );
  }
}

class _FloatingArt extends StatefulWidget {
  const _FloatingArt({required this.playing, required this.child});
  final bool playing;
  final Widget child;

  @override
  State<_FloatingArt> createState() => _FloatingArtState();
}

class _FloatingArtState extends State<_FloatingArt> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 7000))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.playing) return widget.child;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) => Transform.translate(offset: Offset(0, -6 * Curves.easeInOut.transform(_c.value)), child: widget.child),
    );
  }
}

/// A full-width animated bar visualizer, fading softly into the card at both edges —
/// only animates while genuinely playing (§ Animation: no flashing, bars ease up/down).
/// Purely decorative; the real transport state is the progress bar below it. Each bar
/// is `Expanded` so the row always spans its container edge-to-edge.
class AvrWaveform extends StatefulWidget {
  const AvrWaveform({super.key, required this.playing, this.muted = false});
  final bool playing;
  final bool muted;

  @override
  State<AvrWaveform> createState() => _AvrWaveformState();
}

class _AvrWaveformState extends State<AvrWaveform> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1150))..repeat();
  static const _bars = 48;
  final _seeds = List.generate(_bars, (i) => (i * 0.13) % 1.0);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return ShaderMask(
      shaderCallback: (rect) => const LinearGradient(
        colors: [Colors.transparent, Colors.black, Colors.black, Colors.transparent],
        stops: [0, 0.08, 0.92, 1],
      ).createShader(rect),
      child: SizedBox(
        height: 40,
        width: double.infinity,
        child: AnimatedBuilder(
          animation: _c,
          builder: (context, _) {
            return Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                for (var i = 0; i < _bars; i++)
                  Expanded(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 1.5),
                      child: AnimatedOpacity(
                        duration: const Duration(milliseconds: 300),
                        opacity: widget.muted ? 0.35 : 1,
                        child: Container(
                          height: widget.playing ? 6 + 30 * (0.5 + 0.5 * math.sin((_c.value * 2 * math.pi) + _seeds[i] * 2 * math.pi)) : 4,
                          decoration: BoxDecoration(
                            gradient: widget.playing ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500]) : null,
                            color: widget.playing ? null : AureonBase.hairline,
                            borderRadius: BorderRadius.circular(2),
                            boxShadow: widget.playing && !widget.muted ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.4), blurRadius: 5)] : null,
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Styled after a physical AVR/preamp knob: an outer ring of tick marks (lit gold up
/// to the current level, dim otherwise) plus a slim inner progress arc — the same
/// two-layer language as the web dial.
class _DialPainter extends CustomPainter {
  _DialPainter(this.pct);
  final double pct;
  static const _tickCount = 48;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final tickRadius = size.width / 2 - 6;
    final lit = (pct.clamp(0, 1) * _tickCount).round();
    for (var i = 0; i < _tickCount; i++) {
      final angle = (i / _tickCount) * 2 * math.pi - math.pi / 2;
      final major = i % 4 == 0;
      final len = major ? 11.0 : 8.0;
      final on = i < lit;
      final p1 = center + Offset(math.cos(angle), math.sin(angle)) * (tickRadius - len);
      final p2 = center + Offset(math.cos(angle), math.sin(angle)) * tickRadius;
      final paint = Paint()
        ..color = on ? AureonGold.c400 : AureonBase.hairline
        ..strokeWidth = major ? 2.5 : 2
        ..strokeCap = StrokeCap.round;
      if (on) {
        paint.maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.2);
      }
      canvas.drawLine(p1, p2, paint);
    }
    final arcRadius = tickRadius - 20;
    final track = Paint()..color = AureonBase.hairline.withValues(alpha: 0.7)..style = PaintingStyle.stroke..strokeWidth = 3;
    canvas.drawCircle(center, arcRadius, track);
    final fill = Paint()
      ..color = AureonGold.c400
      ..style = PaintingStyle.stroke
      ..strokeWidth = 3
      ..strokeCap = StrokeCap.round
      ..maskFilter = const MaskFilter.blur(BlurStyle.normal, 1.0);
    canvas.drawArc(Rect.fromCircle(center: center, radius: arcRadius), -math.pi / 2, 2 * math.pi * pct.clamp(0, 1), false, fill);

    // Brushed-metal texture: extremely fine radial striations on the knob face, well
    // inside the tick ring, low-opacity so they read as a material finish.
    final faceRadius = arcRadius - 14;
    final brush = Paint()..color = Colors.white.withValues(alpha: 0.025)..strokeWidth = 1;
    for (var i = 0; i < 120; i++) {
      final angle = (i / 120) * 2 * math.pi;
      final p1 = center + Offset(math.cos(angle), math.sin(angle)) * (faceRadius * 0.15);
      final p2 = center + Offset(math.cos(angle), math.sin(angle)) * faceRadius;
      canvas.drawLine(p1, p2, brush);
    }
  }

  @override
  bool shouldRepaint(covariant _DialPainter old) => old.pct != pct;
}

class AvrVolumeDial extends StatefulWidget {
  const AvrVolumeDial({super.key, required this.volume, required this.volumeDb, required this.muted, required this.onChanged, required this.onMuteToggle, this.size = 208});
  final double volume;
  final double? volumeDb;
  final bool muted;
  final ValueChanged<double> onChanged;
  final VoidCallback onMuteToggle;
  final double size;

  @override
  State<AvrVolumeDial> createState() => _AvrVolumeDialState();
}

class _AvrVolumeDialState extends State<AvrVolumeDial> {
  static const _tickCount = 48;
  bool _pressed = false;
  int _lastTick = -1;

  void _onChanged(double v) {
    final tick = ((v.clamp(0, 100) / 100) * _tickCount).round();
    if (tick != _lastTick) {
      // A tiny detent click each time the dial crosses a new tick — mirrors a real
      // knob's physical stops.
      HapticFeedback.selectionClick();
      _lastTick = tick;
    }
    widget.onChanged(v);
  }

  @override
  Widget build(BuildContext context) {
    final size = widget.size;
    return Column(children: [
      AnimatedScale(
        scale: _pressed ? 0.985 : 1,
        duration: const Duration(milliseconds: 120),
        curve: Curves.easeOut,
        child: SizedBox(
          width: size, height: size,
          child: Stack(alignment: Alignment.center, children: [
            // Recessed metal-toned knob face.
            Container(
              width: size - 16, height: size - 16,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: RadialGradient(
                  center: const Alignment(0, -0.2),
                  colors: [Color.lerp(AureonBase.surfaceRaised, Colors.white, 0.03)!, AureonBase.surface, Color.lerp(AureonBase.voidColor, Colors.black, 0.15)!],
                  stops: const [0, 0.6, 1],
                ),
                boxShadow: [
                  BoxShadow(color: Colors.black.withValues(alpha: 0.45), blurRadius: 26, offset: const Offset(0, 14)),
                  BoxShadow(color: Colors.white.withValues(alpha: 0.04), blurRadius: 0, spreadRadius: 0.5),
                  // Rotation-reactive lighting (§ Volume Knob: "lighting reacts while
                  // rotating") — the glow genuinely brightens with the real volume
                  // level, not a fixed decoration.
                  BoxShadow(color: AureonGold.c400.withValues(alpha: 0.05 + (widget.volume / 100) * 0.22), blurRadius: 14 + (widget.volume / 100) * 22),
                  if (_pressed) BoxShadow(color: AureonGold.c400.withValues(alpha: 0.18), blurRadius: 30, spreadRadius: 2),
                ],
              ),
            ),
            // Soft specular reflection — a single diagonal highlight, like glass/metal
            // catching light from the upper-left, not a hard glare.
            Container(
              width: size - 24, height: size - 24,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                gradient: LinearGradient(
                  begin: Alignment.topLeft, end: const Alignment(0.2, 0.4),
                  colors: [Colors.white.withValues(alpha: 0.08), Colors.white.withValues(alpha: 0)],
                ),
              ),
            ),
            CustomPaint(size: Size(size, size), painter: _DialPainter(widget.volume / 100)),
            Column(mainAxisSize: MainAxisSize.min, children: [
              Text(widget.volumeDb != null ? widget.volumeDb!.toStringAsFixed(1) : widget.volume.round().toString(), style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w600, color: AureonText.primary, letterSpacing: -0.3)),
              Text(widget.volumeDb != null ? 'dB' : '%', style: const TextStyle(fontSize: 12, color: AureonText.secondary)),
              const SizedBox(height: 10),
              const Text('MASTER VOLUME', style: TextStyle(fontSize: 10, letterSpacing: 1.6, color: AureonText.secondary)),
            ]),
            Positioned.fill(
              child: RotatedBox(
                quarterTurns: 3,
                child: SliderTheme(
                  data: SliderTheme.of(context).copyWith(
                    trackHeight: 0, thumbShape: SliderComponentShape.noThumb, overlayShape: SliderComponentShape.noOverlay,
                  ),
                  child: Slider(
                    value: widget.volume.clamp(0, 100), max: 100,
                    onChangeStart: (_) => setState(() => _pressed = true),
                    onChanged: _onChanged,
                    onChangeEnd: (_) => setState(() => _pressed = false),
                    activeColor: Colors.transparent, inactiveColor: Colors.transparent,
                  ),
                ),
              ),
            ),
          ]),
        ),
      ),
      const SizedBox(height: 16),
      IconButton.filled(
        onPressed: () { HapticFeedback.lightImpact(); widget.onMuteToggle(); },
        icon: Icon(widget.muted ? Icons.volume_off : Icons.volume_up),
        style: IconButton.styleFrom(
          backgroundColor: widget.muted ? AureonGold.c400 : AureonBase.surface,
          foregroundColor: widget.muted ? AureonText.inverse : AureonText.primary,
          elevation: widget.muted ? 6 : 0,
          shadowColor: AureonGold.c400.withValues(alpha: 0.5),
          side: widget.muted ? null : BorderSide(color: AureonBase.hairline),
        ),
      ),
    ]);
  }
}

class AvrModeChips extends StatelessWidget {
  const AvrModeChips({super.key, required this.label, required this.modes, required this.active, required this.onSelect});
  final String label;
  final List<({String id, String label})> modes;
  final String? active;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (modes.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(label.toUpperCase(), style: const TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in modes) _AvrChip(label: m.label, selected: active == m.id, onTap: () => onSelect(m.id)),
      ]),
    ]);
  }
}

/// Hardware-style listening-mode buttons (§ Listening Modes: "resemble luxury hardware
/// buttons rather than software chips") — a real icon per mode (matched generically),
/// rectangular with a pressed/engraved look, instead of a pill chip.
class AvrListeningModeButtons extends StatelessWidget {
  const AvrListeningModeButtons({super.key, required this.modes, required this.active, required this.onSelect});
  final List<({String id, String label})> modes;
  final String? active;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (modes.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('LISTENING MODE', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in modes)
          Material(
            color: Colors.transparent,
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.sm + 2),
              onTap: () { HapticFeedback.selectionClick(); onSelect(m.id); },
              child: AnimatedContainer(
                duration: AureonMotion.base,
                width: 78,
                padding: const EdgeInsets.symmetric(vertical: 10),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.sm + 2),
                  gradient: active == m.id ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500]) : LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [Color.lerp(AureonBase.surface, Colors.white, 0.03)!, AureonBase.surface]),
                  border: Border.all(color: active == m.id ? Colors.transparent : AureonBase.hairline),
                  boxShadow: active == m.id
                      ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 5))]
                      : [BoxShadow(color: Colors.white.withValues(alpha: 0.04), blurRadius: 0, spreadRadius: 0.5), const BoxShadow(color: Colors.black26, blurRadius: 3, offset: Offset(0, 1))],
                ),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  Icon(soundModeIcon(m.label), size: 18, color: active == m.id ? AureonText.inverse : AureonText.primary),
                  const SizedBox(height: 4),
                  Text(m.label.toUpperCase(), textAlign: TextAlign.center, style: TextStyle(fontSize: 9.5, fontWeight: FontWeight.w700, letterSpacing: 0.2, color: active == m.id ? AureonText.inverse : AureonText.primary)),
                ]),
              ),
            ),
          ),
      ]),
    ]);
  }
}

/// A custom chip (rather than Material's ChoiceChip) so the "on" state can carry a
/// gold gradient + soft glow — the same restrained "gold only when active" language
/// used everywhere else in this console.
class _AvrChip extends StatelessWidget {
  const _AvrChip({required this.label, required this.selected, required this.onTap});
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return Material(
      color: Colors.transparent,
      child: InkWell(
        borderRadius: BorderRadius.circular(AureonRadius.pill),
        onTap: () { HapticFeedback.selectionClick(); onTap(); },
        child: AnimatedContainer(
          duration: AureonMotion.base,
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(AureonRadius.pill),
            gradient: selected ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500]) : null,
            color: selected ? null : AureonBase.surface,
            border: Border.all(color: selected ? Colors.transparent : AureonBase.hairline),
            boxShadow: selected ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 4))] : null,
          ),
          child: Text(label, style: TextStyle(fontSize: 12.5, letterSpacing: 0.2, color: selected ? AureonText.inverse : AureonText.primary, fontWeight: selected ? FontWeight.w700 : FontWeight.w500)),
        ),
      ),
    );
  }
}

/// Premium input tiles (§ Input Selection): icon + name + connection type + an active
/// glow, replacing plain chips for physical/streaming inputs specifically (as opposed to
/// named listening modes, which stay simple pills). A quick horizontal picker in the
/// main flow; the fuller [AvrSourceList] in the sidebar/below shows the same data with
/// more detail. `pending` lights a brief loading ring on the tile just tapped while its
/// command is in flight — a real receiver's input switch can take a second or two, this
/// isn't decorative.
class AvrInputTiles extends StatelessWidget {
  const AvrInputTiles({super.key, required this.inputs, required this.active, required this.pending, required this.onSelect});
  final List<({String id, String label, String? type})> inputs;
  final String? active;
  final String? pending;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (inputs.isEmpty) return const SizedBox.shrink();
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('INPUT', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      SizedBox(
        height: 66,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          itemCount: inputs.length,
          separatorBuilder: (_, __) => const SizedBox(width: 10),
          itemBuilder: (context, i) {
            final input = inputs[i];
            final selected = active == input.id;
            final loading = pending == input.id;
            return Material(
              color: Colors.transparent,
              child: InkWell(
                borderRadius: BorderRadius.circular(AureonRadius.md),
                onTap: loading ? null : () { HapticFeedback.selectionClick(); onSelect(input.id); },
                child: AnimatedContainer(
                  duration: AureonMotion.base,
                  width: 96,
                  padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(AureonRadius.md),
                    gradient: selected ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500]) : null,
                    color: selected ? null : AureonBase.surface,
                    border: Border.all(color: selected ? Colors.transparent : AureonBase.hairline),
                    boxShadow: selected ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.35), blurRadius: 14, offset: const Offset(0, 4))] : null,
                  ),
                  child: Stack(children: [
                    Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
                      Icon(inputIcon(input.type), size: 17, color: selected ? AureonText.inverse : AureonText.primary),
                      const SizedBox(height: 4),
                      Text(input.label, maxLines: 1, overflow: TextOverflow.ellipsis, style: TextStyle(fontSize: 12.5, fontWeight: FontWeight.w600, color: selected ? AureonText.inverse : AureonText.primary)),
                      if (input.type != null)
                        Text(input.type!.toUpperCase(), style: TextStyle(fontSize: 9, letterSpacing: 0.4, color: selected ? Color.lerp(AureonText.inverse, Colors.transparent, 0.3) : AureonText.secondary)),
                    ]),
                    if (loading)
                      Positioned(
                        top: 0, right: 0,
                        child: SizedBox(
                          width: 12, height: 12,
                          child: CircularProgressIndicator(strokeWidth: 2, valueColor: AlwaysStoppedAnimation(selected ? AureonText.inverse : AureonGold.c400)),
                        ),
                      ),
                  ]),
                ),
              ),
            );
          },
        ),
      ),
    ]);
  }
}

class AvrSourceList extends StatelessWidget {
  const AvrSourceList({super.key, required this.inputs, required this.active, required this.pending, required this.onSelect});
  final List<({String id, String label, String? type})> inputs;
  final String? active;
  final String? pending;
  final ValueChanged<String> onSelect;

  @override
  Widget build(BuildContext context) {
    if (inputs.isEmpty) return const SizedBox.shrink();
    return AvrCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      const Text('SOURCE', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 9),
      for (final i in inputs)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(AureonRadius.md),
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.md),
              onTap: pending == i.id ? null : () { HapticFeedback.selectionClick(); onSelect(i.id); },
              child: AnimatedContainer(
                duration: AureonMotion.base,
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
                decoration: BoxDecoration(
                  color: active == i.id ? AureonGold.c400.withValues(alpha: 0.10) : AureonBase.surface,
                  borderRadius: BorderRadius.circular(AureonRadius.md),
                  border: Border.all(color: active == i.id ? AureonGold.c400.withValues(alpha: 0.55) : Colors.transparent),
                ),
                child: Row(children: [
                  Icon(inputIcon(i.type), size: 20, color: active == i.id ? AureonGold.c400 : AureonText.primary),
                  const SizedBox(width: 13),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(i.label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                    if (i.type != null) Text(i.type!.toUpperCase(), style: const TextStyle(fontSize: 9.5, letterSpacing: 0.4, color: AureonText.secondary)),
                  ])),
                  if (pending == i.id)
                    SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, valueColor: AlwaysStoppedAnimation(AureonGold.c400)))
                  else if (active == i.id)
                    const Icon(Icons.check, size: 18, color: AureonGold.c400),
                ]),
              ),
            ),
          ),
        ),
    ]));
  }
}

/// Renders whatever `mediaAdvancedControls` this device declares — the ONLY mechanism a
/// brand-specific quick action (Sleep Timer, …) reaches this UI.
class AvrQuickActions extends StatelessWidget {
  const AvrQuickActions({
    super.key, required this.muted, required this.onMuteToggle,
    required this.controls, required this.advanced, required this.onSetAdvanced,
  });
  final bool muted;
  final VoidCallback onMuteToggle;
  final List<MediaAdvancedControl> controls;
  final Map<String, dynamic> advanced;
  final void Function(String key, dynamic value) onSetAdvanced;

  Future<void> _pick(BuildContext context, MediaAdvancedControl ctl) async {
    final current = advanced[ctl.key];
    final chosen = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AureonBase.surfaceRaised,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(AureonRadius.lg))),
      builder: (_) => SafeArea(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Padding(padding: const EdgeInsets.all(AureonSpacing.md), child: Text(ctl.label, style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 16))),
          for (final o in ctl.options)
            ListTile(
              title: Text(o.label),
              trailing: '$current' == o.id ? const Icon(Icons.check, color: AureonGold.c400) : null,
              onTap: () => Navigator.of(context).pop(o.id),
            ),
        ]),
      ),
    );
    if (chosen != null) {
      final n = num.tryParse(chosen);
      onSetAdvanced(ctl.key, n ?? chosen);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AvrCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      const Text('QUICK ACTIONS', style: TextStyle(fontSize: 10.5, letterSpacing: 1.4, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 10),
      Wrap(spacing: 10, runSpacing: 10, children: [
        _tile(context, icon: muted ? Icons.volume_off : Icons.volume_up, label: 'Audio Mute', value: null, on: muted, onTap: onMuteToggle),
        for (final ctl in controls)
          _tile(
            context,
            icon: ctl.icon == 'sleep' ? Icons.bedtime_outlined : Icons.tune,
            label: ctl.label,
            value: ctl.options.where((o) => o.id == '${advanced[ctl.key] ?? '0'}').map((o) => o.label).firstOrNull ?? '—',
            on: (advanced[ctl.key] ?? 0).toString() != '0',
            onTap: () => _pick(context, ctl),
          ),
      ]),
    ]));
  }

  // Glass quick-action button: translucent + blurred, a hairline top highlight to
  // catch light like brushed metal, gold reserved strictly for the "on" state.
  Widget _tile(BuildContext context, {required IconData icon, required String label, required String? value, required bool on, required VoidCallback onTap}) {
    return SizedBox(
      width: (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2 > 220 ? 220 : (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(AureonRadius.lg),
        child: BackdropFilter(
          filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
          child: Material(
            color: AureonBase.surfaceRaised.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(AureonRadius.lg),
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              onTap: () { HapticFeedback.selectionClick(); onTap(); },
              child: Container(
                padding: const EdgeInsets.all(16),
                constraints: const BoxConstraints(minHeight: 92),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.lg),
                  border: Border.all(color: on ? AureonGold.c400.withValues(alpha: 0.55) : Colors.white.withValues(alpha: 0.08)),
                  boxShadow: on
                      ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.28), blurRadius: 16, offset: const Offset(0, 6))]
                      : [BoxShadow(color: Colors.black.withValues(alpha: 0.28), blurRadius: 14, offset: const Offset(0, 6))],
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Icon(icon, size: 24, color: on ? AureonGold.c400 : AureonText.primary),
                  const SizedBox(height: 8),
                  Text(label, style: const TextStyle(fontSize: 12.5)),
                  if (value != null) Text(value, style: const TextStyle(fontSize: 11, color: AureonText.secondary)),
                ]),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class AvrTransportRow extends StatelessWidget {
  const AvrTransportRow({
    super.key, required this.playing, required this.showPrevious, required this.showNext, required this.showPlayPause,
    required this.onToggle, required this.onPrevious, required this.onNext,
  });
  final bool playing;
  final bool showPrevious;
  final bool showNext;
  final bool showPlayPause;
  final VoidCallback onToggle;
  final VoidCallback onPrevious;
  final VoidCallback onNext;

  @override
  Widget build(BuildContext context) {
    return Row(mainAxisAlignment: MainAxisAlignment.center, children: [
      if (showPrevious) IconButton(iconSize: 30, onPressed: () { HapticFeedback.selectionClick(); onPrevious(); }, icon: const Icon(Icons.skip_previous)),
      if (showPrevious) const SizedBox(width: 12),
      if (showPlayPause)
        IconButton.filled(
          iconSize: 30,
          onPressed: onToggle,
          icon: Icon(playing ? Icons.pause : Icons.play_arrow),
          style: IconButton.styleFrom(backgroundColor: AureonGold.c400, foregroundColor: AureonText.inverse, minimumSize: const Size(64, 64)),
        ),
      if (showNext) const SizedBox(width: 12),
      if (showNext) IconButton(iconSize: 30, onPressed: () { HapticFeedback.selectionClick(); onNext(); }, icon: const Icon(Icons.skip_next)),
    ]);
  }
}

enum AvrConsoleLayout { compact, wide }

/// The full AVR console content — everything below the header/manage chrome, which the
/// two callers (the phone bottom sheet, the tablet full-page console) own themselves
/// since their surrounding chrome differs. `layout` switches between a single-column
/// stack (phone) and a two-pane split (tablet) — the SAME underlying data and widgets,
/// just arranged differently, per "a dedicated tablet layout, not a stretched
/// desktop/mobile UI".
class AvrConsoleBody extends ConsumerStatefulWidget {
  const AvrConsoleBody({super.key, required this.device, required this.layout, this.onNavigateSibling});
  final Device device;
  final AvrConsoleLayout layout;
  /// Called when the user taps a sibling zone in the Zone selector — the caller decides
  /// how to present that other device (reopen the sheet, push the tablet console, …),
  /// since that decision depends on chrome only the caller owns.
  final void Function(BuildContext context, Device device)? onNavigateSibling;

  @override
  ConsumerState<AvrConsoleBody> createState() => _AvrConsoleBodyState();
}

class _AvrConsoleBodyState extends ConsumerState<AvrConsoleBody> {
  double? _seekPreview;
  String? _pendingSource;

  // A real receiver only reports positionSec on its own cadence (HEOS pushes progress
  // every few seconds; Yamaha/Denon only on poll) — ticking it forward locally between
  // those updates is what makes the progress bar read as "live" rather than jumpy. The
  // anchor resets to the server's true value whenever a fresh one arrives; the tick
  // timer only ever advances the DISPLAYED estimate, never the value sent to the device.
  double? _positionAnchorValue;
  DateTime? _positionAnchorAt;
  double? _lastRawPositionSec;
  Timer? _positionTicker;

  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);
  void _apply(String capability, Map<String, dynamic> value) => ref.read(liveStatesProvider.notifier).apply(widget.device.id, capability, value);

  void _syncPositionTicker(bool playing) {
    final wantsTicking = playing && mounted;
    if (wantsTicking && _positionTicker == null) {
      _positionTicker = Timer.periodic(const Duration(seconds: 1), (_) { if (mounted) setState(() {}); });
    } else if (!wantsTicking && _positionTicker != null) {
      _positionTicker!.cancel();
      _positionTicker = null;
    }
  }

  @override
  void dispose() {
    _positionTicker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(liveStatesProvider);
    final allDevices = ref.watch(allDevicesProvider).valueOrNull ?? const <Device>[];
    final merged = mergedDeviceState(widget.device, live);
    final m = (merged['media'] as Map<String, dynamic>?) ?? const {};
    final advanced = (m['advanced'] as Map<String, dynamic>?) ?? const {};

    final playing = m['playback'] == 'playing';
    final volume = ((m['volume'] as num?) ?? 0).toDouble();
    final muted = (m['muted'] as bool?) ?? false;
    final title = m['title'] as String?;
    final artist = m['artist'] as String?;
    final album = m['album'] as String?;
    final artworkUrl = m['artworkUrl'] as String?;
    final durationSec = (m['durationSec'] as num?)?.toDouble();
    final rawPositionSec = (m['positionSec'] as num?)?.toDouble();
    if (rawPositionSec != _lastRawPositionSec) {
      _lastRawPositionSec = rawPositionSec;
      _positionAnchorValue = rawPositionSec;
      _positionAnchorAt = DateTime.now();
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _syncPositionTicker(playing));
    final double? livePositionSec = _positionAnchorValue == null
        ? null
        : !playing
            ? _positionAnchorValue
            : (durationSec != null
                ? math.min(_positionAnchorValue! + DateTime.now().difference(_positionAnchorAt!).inMilliseconds / 1000, durationSec)
                : _positionAnchorValue! + DateTime.now().difference(_positionAnchorAt!).inMilliseconds / 1000);
    final positionSec = _seekPreview ?? livePositionSec;
    final source = m['source'] as String?;
    final volumeDb = advanced['volumeDb'] is num ? (advanced['volumeDb'] as num).toDouble() : null;
    final soundMode = advanced['soundMode'] as String?;

    final inputs = widget.device.mediaInputs;
    final soundModes = widget.device.mediaSoundModes;
    final advancedControls = widget.device.mediaAdvancedControls;
    final siblings = zoneSiblings(widget.device, allDevices);
    final roomDevices = allDevices.where((d) => d.roomId == widget.device.roomId).toList();
    final contextItems = roomStatus(widget.device, m, roomDevices);

    void toggle() {
      HapticFeedback.lightImpact();
      _apply('media', {...m, 'playback': playing ? 'paused' : 'playing'});
      _cmd({'capability': 'media', 'action': playing ? 'pause' : 'play'});
    }

    void setVolume(double v) {
      _apply('media', {...m, 'volume': v});
      _cmd({'capability': 'media', 'action': 'volume', 'volume': v.round()});
    }

    void setMuted() {
      _apply('media', {...m, 'muted': !muted});
      _cmd({'capability': 'media', 'action': muted ? 'unmute' : 'mute'});
    }

    // A real receiver's input switch can take a second or two — `_pendingSource` drives
    // a genuine loading indicator on both input pickers, not a decorative one.
    void setSource(String id) {
      setState(() => _pendingSource = id);
      _apply('media', {...m, 'source': id});
      _cmd({'capability': 'media', 'action': 'source', 'source': id}).whenComplete(() {
        if (mounted && _pendingSource == id) setState(() => _pendingSource = null);
      });
    }

    void setSoundMode(String id) {
      _apply('media', {...m, 'advanced': {...advanced, 'soundMode': id}});
      _cmd({'capability': 'media', 'action': 'advanced', 'advanced': {'soundMode': id}});
    }

    void setAdvanced(String key, dynamic value) {
      _apply('media', {...m, 'advanced': {...advanced, key: value}});
      _cmd({'capability': 'media', 'action': 'advanced', 'advanced': {key: value}});
    }

    void goToDevice(Device d) => widget.onNavigateSibling?.call(context, d);

    // Dynamic context (§ Offline): the hero surface itself reads as quiet/unavailable
    // rather than pretending controls still work when the receiver isn't reachable.
    final nowPlaying = AnimatedOpacity(
      opacity: widget.device.status == 'online' ? 1 : 0.55,
      duration: const Duration(milliseconds: 600),
      child: AvrCard(padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20), child: Column(crossAxisAlignment: CrossAxisAlignment.center, mainAxisSize: MainAxisSize.min, children: [
      AvrAlbumArt(url: artworkUrl, name: widget.device.name, playing: playing),
      const SizedBox(height: 18),
      Text(title ?? 'Idle', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, letterSpacing: -0.2), textAlign: TextAlign.center),
      if (artist != null) Text(artist, style: const TextStyle(fontSize: 13.5, color: AureonText.primary), textAlign: TextAlign.center),
      if (album != null) Text(album, style: const TextStyle(fontSize: 12.5, color: AureonText.secondary), textAlign: TextAlign.center),
      const SizedBox(height: 12),
      AvrWaveform(playing: playing, muted: muted),
      if (durationSec != null) ...[
        const SizedBox(height: 6),
        Slider(
          value: (positionSec ?? 0).clamp(0, durationSec), max: durationSec,
          activeColor: AureonGold.c400,
          onChanged: (v) => setState(() => _seekPreview = v),
          onChangeEnd: (v) { setState(() => _seekPreview = null); _apply('media', {...m, 'positionSec': v}); _cmd({'capability': 'media', 'action': 'seek', 'positionSec': v.round()}); },
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 4),
          child: Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
            Text(fmtTime(positionSec ?? 0), style: const TextStyle(fontSize: 11, color: AureonText.secondary)),
            Text(fmtTime(durationSec), style: const TextStyle(fontSize: 11, color: AureonText.secondary)),
          ]),
        ),
      ],
      const SizedBox(height: 10),
      AvrTransportRow(
        playing: playing, showPrevious: true, showNext: true, showPlayPause: true,
        onToggle: toggle,
        onPrevious: () => _cmd({'capability': 'media', 'action': 'previous'}),
        onNext: () => _cmd({'capability': 'media', 'action': 'next'}),
      ),
    ])),
    );

    final volumeSection = AvrVolumeDial(volume: volume, volumeDb: volumeDb, muted: muted, onChanged: setVolume, onMuteToggle: setMuted);

    final fields = AvrCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      if (inputs.isNotEmpty) ...[
        AvrInputTiles(inputs: inputs, active: source, pending: _pendingSource, onSelect: setSource),
        const SizedBox(height: 16),
      ],
      AvrListeningModeButtons(modes: soundModes, active: soundMode, onSelect: setSoundMode),
      if (soundModes.isNotEmpty) const SizedBox(height: 16),
      if (siblings.isNotEmpty) ...[
        AvrModeChips(
          label: 'Zone',
          modes: [(id: widget.device.id, label: widget.device.name), for (final s in siblings) (id: s.id, label: s.name)],
          active: widget.device.id,
          onSelect: (id) { final d = siblings.where((s) => s.id == id).firstOrNull; if (d != null) goToDevice(d); },
        ),
        const SizedBox(height: 16),
      ],
    ]));

    final quickActions = AvrQuickActions(muted: muted, onMuteToggle: setMuted, controls: advancedControls, advanced: advanced, onSetAdvanced: setAdvanced);
    final sourceList = AvrSourceList(inputs: inputs, active: source, pending: _pendingSource, onSelect: setSource);

    if (widget.layout == AvrConsoleLayout.wide) {
      return Column(children: [
        if (contextItems.isNotEmpty) Padding(padding: const EdgeInsets.fromLTRB(AureonSpacing.lg, AureonSpacing.md, AureonSpacing.lg, 0), child: EntertainmentStatus(items: contextItems)),
        Expanded(
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Expanded(flex: 3, child: Padding(padding: const EdgeInsets.all(AureonSpacing.lg), child: SingleChildScrollView(child: Column(children: [nowPlaying, const SizedBox(height: 20), sourceList])))),
            Container(width: 1, color: AureonBase.hairline),
            Expanded(flex: 2, child: Padding(padding: const EdgeInsets.all(AureonSpacing.lg), child: SingleChildScrollView(child: Column(children: [volumeSection, const SizedBox(height: 24), fields, const SizedBox(height: 24), quickActions])))),
          ]),
        ),
      ]);
    }

    // Compact (phone): the caller (a bottom sheet) already provides the scrollable
    // context, so this is a plain Column — nesting another scroll view here would
    // fight the outer one for gesture/scroll-extent ownership.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Column(children: [
        if (contextItems.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 16), child: EntertainmentStatus(items: contextItems)),
        nowPlaying,
        const SizedBox(height: 20),
        volumeSection,
        const SizedBox(height: 20),
        fields,
        const SizedBox(height: 4),
        quickActions,
        const SizedBox(height: 12),
        sourceList,
      ]),
    );
  }
}

/// Whether this screen is tablet-sized (§ Tablet Layout: "a dedicated tablet layout,
/// not a stretched desktop/mobile UI"). `shortestSide` (not raw width) so a phone in
/// landscape isn't mistaken for a tablet.
bool isTabletWidth(BuildContext context) => MediaQuery.of(context).size.shortestSide >= 600;
