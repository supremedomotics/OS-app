import 'dart:math' as math;
import 'dart:ui';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
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

// ── Ambient halo — a slow pulse behind the artwork; never flashes ───────────────────
class AvrAmbientHalo extends StatefulWidget {
  const AvrAmbientHalo({super.key, required this.playing});
  final bool playing;

  @override
  State<AvrAmbientHalo> createState() => _AvrAmbientHaloState();
}

class _AvrAmbientHaloState extends State<AvrAmbientHalo> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 6000))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    // A quiet, always-present glow — barely visible at rest, breathing slowly
    // wider/brighter only while genuinely playing. Two soft layers (a wide diffuse
    // bloom + a tighter core) read as depth rather than a flat colored circle.
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = widget.playing ? Curves.easeInOut.transform(_c.value) : 0.0;
        final baseAlpha = widget.playing ? 0.30 : 0.08;
        return Stack(alignment: Alignment.center, children: [
          Container(
            width: 248 + t * 26, height: 248 + t * 26,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [AureonGold.c400.withValues(alpha: baseAlpha + t * 0.14), AureonGold.c400.withValues(alpha: 0)]),
            ),
          ),
          Container(
            width: 190 + t * 14, height: 190 + t * 14,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(colors: [AureonGold.c200.withValues(alpha: (baseAlpha + t * 0.16) * 0.9), AureonGold.c200.withValues(alpha: 0)]),
            ),
          ),
        ]);
      },
    );
  }
}

class AvrAlbumArt extends StatelessWidget {
  const AvrAlbumArt({super.key, required this.url, required this.name, required this.playing, this.size = 216});
  final String? url;
  final String name;
  final bool playing;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size + 32, height: size + 32,
      child: Stack(alignment: Alignment.center, children: [
        AvrAmbientHalo(playing: playing),
        Container(
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
            child: url != null
                ? Image.network(url!, width: size, height: size, fit: BoxFit.cover)
                : Container(
                    width: size, height: size,
                    decoration: BoxDecoration(
                      gradient: LinearGradient(
                        begin: Alignment.topLeft, end: Alignment.bottomRight,
                        colors: [AureonBase.surface, Color.lerp(AureonBase.surface, Colors.black, 0.25)!],
                      ),
                    ),
                    alignment: Alignment.center,
                    child: Text(name.isNotEmpty ? name[0].toUpperCase() : '♪', style: TextStyle(fontSize: size * 0.30, fontWeight: FontWeight.w600, color: AureonGold.c400)),
                  ),
          ),
        ),
      ]),
    );
  }
}

/// A slim animated bar visualizer — only animates while genuinely playing (§ Animation:
/// no flashing, bars ease up/down). Purely decorative.
class AvrWaveform extends StatefulWidget {
  const AvrWaveform({super.key, required this.playing});
  final bool playing;

  @override
  State<AvrWaveform> createState() => _AvrWaveformState();
}

class _AvrWaveformState extends State<AvrWaveform> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1150))..repeat();
  static const _bars = 30;
  final _seeds = List.generate(_bars, (i) => (i * 0.13) % 1.0);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 40,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var i = 0; i < _bars; i++)
                Padding(
                  padding: const EdgeInsets.only(right: 3),
                  child: Container(
                    width: 4,
                    height: widget.playing ? 6 + 30 * (0.5 + 0.5 * math.sin((_c.value * 2 * math.pi) + _seeds[i] * 2 * math.pi)) : 4,
                    decoration: BoxDecoration(
                      gradient: widget.playing ? LinearGradient(begin: Alignment.topCenter, end: Alignment.bottomCenter, colors: [AureonGold.c200, AureonGold.c500]) : null,
                      color: widget.playing ? null : AureonBase.hairline,
                      borderRadius: BorderRadius.circular(2),
                      boxShadow: widget.playing ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.4), blurRadius: 5)] : null,
                    ),
                  ),
                ),
            ],
          );
        },
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
  }

  @override
  bool shouldRepaint(covariant _DialPainter old) => old.pct != pct;
}

class AvrVolumeDial extends StatelessWidget {
  const AvrVolumeDial({super.key, required this.volume, required this.volumeDb, required this.muted, required this.onChanged, required this.onMuteToggle, this.size = 208});
  final double volume;
  final double? volumeDb;
  final bool muted;
  final ValueChanged<double> onChanged;
  final VoidCallback onMuteToggle;
  final double size;

  @override
  Widget build(BuildContext context) {
    return Column(children: [
      SizedBox(
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
              ],
            ),
          ),
          CustomPaint(size: Size(size, size), painter: _DialPainter(volume / 100)),
          Column(mainAxisSize: MainAxisSize.min, children: [
            Text(volumeDb != null ? volumeDb!.toStringAsFixed(1) : volume.round().toString(), style: const TextStyle(fontSize: 36, fontWeight: FontWeight.w600, color: AureonText.primary, letterSpacing: -0.3)),
            Text(volumeDb != null ? 'dB' : '%', style: const TextStyle(fontSize: 12, color: AureonText.secondary)),
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
                child: Slider(value: volume.clamp(0, 100), max: 100, onChanged: onChanged, activeColor: Colors.transparent, inactiveColor: Colors.transparent),
              ),
            ),
          ),
        ]),
      ),
      const SizedBox(height: 16),
      IconButton.filled(
        onPressed: onMuteToggle,
        icon: Icon(muted ? Icons.volume_off : Icons.volume_up),
        style: IconButton.styleFrom(
          backgroundColor: muted ? AureonGold.c400 : AureonBase.surface,
          foregroundColor: muted ? AureonText.inverse : AureonText.primary,
          elevation: muted ? 6 : 0,
          shadowColor: AureonGold.c400.withValues(alpha: 0.5),
          side: muted ? null : BorderSide(color: AureonBase.hairline),
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
        onTap: onTap,
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

class AvrSourceList extends StatelessWidget {
  const AvrSourceList({super.key, required this.inputs, required this.active, required this.onSelect});
  final List<({String id, String label, String? type})> inputs;
  final String? active;
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
              onTap: () => onSelect(i.id),
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
                  if (active == i.id) const Icon(Icons.check, size: 18, color: AureonGold.c400),
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
          filter: ImageFilter.blur(sigmaX: 14, sigmaY: 14),
          child: Material(
            color: AureonBase.surfaceRaised.withValues(alpha: 0.5),
            borderRadius: BorderRadius.circular(AureonRadius.lg),
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.lg),
              onTap: onTap,
              child: Container(
                padding: const EdgeInsets.all(13),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.lg),
                  border: Border.all(color: on ? AureonGold.c400.withValues(alpha: 0.55) : Colors.white.withValues(alpha: 0.08)),
                  boxShadow: on
                      ? [BoxShadow(color: AureonGold.c400.withValues(alpha: 0.28), blurRadius: 16, offset: const Offset(0, 6))]
                      : [BoxShadow(color: Colors.black.withValues(alpha: 0.28), blurRadius: 14, offset: const Offset(0, 6))],
                ),
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                  Icon(icon, size: 18, color: on ? AureonGold.c400 : AureonText.primary),
                  const SizedBox(height: 5),
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
      if (showPrevious) IconButton(iconSize: 30, onPressed: onPrevious, icon: const Icon(Icons.skip_previous)),
      if (showPrevious) const SizedBox(width: 12),
      if (showPlayPause)
        IconButton.filled(
          iconSize: 30,
          onPressed: onToggle,
          icon: Icon(playing ? Icons.pause : Icons.play_arrow),
          style: IconButton.styleFrom(backgroundColor: AureonGold.c400, foregroundColor: AureonText.inverse, minimumSize: const Size(64, 64)),
        ),
      if (showNext) const SizedBox(width: 12),
      if (showNext) IconButton(iconSize: 30, onPressed: onNext, icon: const Icon(Icons.skip_next)),
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

  Future<void> _cmd(Map<String, dynamic> c) => ref.read(clientProvider).command(widget.device.id, c);
  void _apply(String capability, Map<String, dynamic> value) => ref.read(liveStatesProvider.notifier).apply(widget.device.id, capability, value);

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
    final positionSec = _seekPreview ?? (m['positionSec'] as num?)?.toDouble();
    final source = m['source'] as String?;
    final volumeDb = advanced['volumeDb'] is num ? (advanced['volumeDb'] as num).toDouble() : null;
    final soundMode = advanced['soundMode'] as String?;

    final inputs = widget.device.mediaInputs;
    final soundModes = widget.device.mediaSoundModes;
    final advancedControls = widget.device.mediaAdvancedControls;
    final siblings = zoneSiblings(widget.device, allDevices);

    void toggle() {
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

    void setSource(String id) {
      _apply('media', {...m, 'source': id});
      _cmd({'capability': 'media', 'action': 'source', 'source': id});
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

    final nowPlaying = AvrCard(padding: const EdgeInsets.symmetric(vertical: 24, horizontal: 20), child: Column(crossAxisAlignment: CrossAxisAlignment.center, mainAxisSize: MainAxisSize.min, children: [
      AvrAlbumArt(url: artworkUrl, name: widget.device.name, playing: playing),
      const SizedBox(height: 18),
      Text(title ?? 'Idle', style: const TextStyle(fontSize: 20, fontWeight: FontWeight.w600, letterSpacing: -0.2), textAlign: TextAlign.center),
      if (artist != null) Text(artist, style: const TextStyle(fontSize: 13.5, color: AureonText.primary), textAlign: TextAlign.center),
      if (album != null) Text(album, style: const TextStyle(fontSize: 12.5, color: AureonText.secondary), textAlign: TextAlign.center),
      const SizedBox(height: 12),
      AvrWaveform(playing: playing),
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
    ]));

    final volumeSection = AvrVolumeDial(volume: volume, volumeDb: volumeDb, muted: muted, onChanged: setVolume, onMuteToggle: setMuted);

    final fields = AvrCard(child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
      if (inputs.isNotEmpty) ...[
        AvrModeChips(label: 'Input', modes: [for (final i in inputs) (id: i.id, label: i.label)], active: source, onSelect: setSource),
        const SizedBox(height: 16),
      ],
      AvrModeChips(label: 'Listening Mode', modes: soundModes, active: soundMode, onSelect: setSoundMode),
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
    final sourceList = AvrSourceList(inputs: inputs, active: source, onSelect: setSource);

    if (widget.layout == AvrConsoleLayout.wide) {
      return Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(flex: 3, child: Padding(padding: const EdgeInsets.all(AureonSpacing.lg), child: SingleChildScrollView(child: Column(children: [nowPlaying, const SizedBox(height: 20), sourceList])))),
        Container(width: 1, color: AureonBase.hairline),
        Expanded(flex: 2, child: Padding(padding: const EdgeInsets.all(AureonSpacing.lg), child: SingleChildScrollView(child: Column(children: [volumeSection, const SizedBox(height: 24), fields, const SizedBox(height: 24), quickActions])))),
      ]);
    }

    // Compact (phone): the caller (a bottom sheet) already provides the scrollable
    // context, so this is a plain Column — nesting another scroll view here would
    // fight the outer one for gesture/scroll-extent ownership.
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 4),
      child: Column(children: [
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
