import 'dart:math' as math;

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

// ── Ambient halo — a slow pulse behind the artwork; never flashes ───────────────────
class AvrAmbientHalo extends StatefulWidget {
  const AvrAmbientHalo({super.key, required this.playing});
  final bool playing;

  @override
  State<AvrAmbientHalo> createState() => _AvrAmbientHaloState();
}

class _AvrAmbientHaloState extends State<AvrAmbientHalo> with SingleTickerProviderStateMixin {
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 4500))..repeat(reverse: true);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.playing) return const SizedBox.shrink();
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final t = Curves.easeInOut.transform(_c.value);
        return Container(
          width: 200 + t * 24, height: 200 + t * 24,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            gradient: RadialGradient(colors: [AureonGold.c400.withValues(alpha: 0.30 + t * 0.2), AureonGold.c400.withValues(alpha: 0)]),
          ),
        );
      },
    );
  }
}

class AvrAlbumArt extends StatelessWidget {
  const AvrAlbumArt({super.key, required this.url, required this.name, required this.playing, this.size = 176});
  final String? url;
  final String name;
  final bool playing;
  final double size;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: size + 24, height: size + 24,
      child: Stack(alignment: Alignment.center, children: [
        AvrAmbientHalo(playing: playing),
        ClipRRect(
          borderRadius: BorderRadius.circular(AureonRadius.md),
          child: url != null
              ? Image.network(url!, width: size, height: size, fit: BoxFit.cover)
              : Container(
                  width: size, height: size, color: AureonBase.surface,
                  alignment: Alignment.center,
                  child: Text(name.isNotEmpty ? name[0].toUpperCase() : '♪', style: TextStyle(fontSize: size * 0.32, fontWeight: FontWeight.w700, color: AureonGold.c400)),
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
  late final AnimationController _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1100))..repeat();
  static const _bars = 24;
  final _seeds = List.generate(_bars, (i) => (i * 0.13) % 1.0);

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 26,
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              for (var i = 0; i < _bars; i++)
                Padding(
                  padding: const EdgeInsets.only(right: 2),
                  child: Container(
                    width: 3,
                    height: widget.playing ? 6 + 16 * (0.5 + 0.5 * math.sin((_c.value * 2 * math.pi) + _seeds[i] * 2 * math.pi)) : 4,
                    decoration: BoxDecoration(
                      color: widget.playing ? AureonGold.c400 : AureonBase.hairline,
                      borderRadius: BorderRadius.circular(2),
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

class _DialPainter extends CustomPainter {
  _DialPainter(this.pct);
  final double pct;

  @override
  void paint(Canvas canvas, Size size) {
    final center = size.center(Offset.zero);
    final radius = size.width / 2 - 8;
    final track = Paint()..color = AureonBase.hairline..style = PaintingStyle.stroke..strokeWidth = 8;
    canvas.drawCircle(center, radius, track);
    final fill = Paint()..color = AureonGold.c400..style = PaintingStyle.stroke..strokeWidth = 8..strokeCap = StrokeCap.round;
    canvas.drawArc(Rect.fromCircle(center: center, radius: radius), -math.pi / 2, 2 * math.pi * pct.clamp(0, 1), false, fill);
  }

  @override
  bool shouldRepaint(covariant _DialPainter old) => old.pct != pct;
}

class AvrVolumeDial extends StatelessWidget {
  const AvrVolumeDial({super.key, required this.volume, required this.volumeDb, required this.muted, required this.onChanged, required this.onMuteToggle, this.size = 176});
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
          CustomPaint(size: Size(size, size), painter: _DialPainter(volume / 100)),
          Column(mainAxisSize: MainAxisSize.min, children: [
            Text(volumeDb != null ? volumeDb!.toStringAsFixed(1) : volume.round().toString(), style: const TextStyle(fontSize: 30, fontWeight: FontWeight.w700, color: AureonText.primary)),
            Text(volumeDb != null ? 'dB' : '%', style: const TextStyle(fontSize: 12, color: AureonText.secondary)),
            const SizedBox(height: 8),
            const Text('MASTER VOLUME', style: TextStyle(fontSize: 10, letterSpacing: 1.2, color: AureonText.secondary)),
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
      const SizedBox(height: 14),
      IconButton.filled(
        onPressed: onMuteToggle,
        icon: Icon(muted ? Icons.volume_off : Icons.volume_up),
        style: IconButton.styleFrom(backgroundColor: muted ? AureonGold.c400 : AureonBase.surface, foregroundColor: muted ? AureonText.inverse : AureonText.primary),
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
      Text(label.toUpperCase(), style: const TextStyle(fontSize: 11, letterSpacing: 1, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      Wrap(spacing: 8, runSpacing: 8, children: [
        for (final m in modes)
          ChoiceChip(
            label: Text(m.label),
            selected: active == m.id,
            onSelected: (_) => onSelect(m.id),
            selectedColor: AureonGold.c400,
            labelStyle: TextStyle(color: active == m.id ? AureonText.inverse : AureonText.primary, fontWeight: active == m.id ? FontWeight.w700 : FontWeight.w500),
            backgroundColor: AureonBase.surface,
            side: BorderSide(color: AureonBase.hairline),
          ),
      ]),
    ]);
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
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('SOURCE', style: TextStyle(fontSize: 11, letterSpacing: 1, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
      for (final i in inputs)
        Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Material(
            color: active == i.id ? AureonGold.c400.withValues(alpha: 0.14) : AureonBase.surface,
            borderRadius: BorderRadius.circular(AureonRadius.md),
            child: InkWell(
              borderRadius: BorderRadius.circular(AureonRadius.md),
              onTap: () => onSelect(i.id),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(AureonRadius.md),
                  border: Border.all(color: active == i.id ? AureonGold.c400 : Colors.transparent),
                ),
                child: Row(children: [
                  Icon(inputIcon(i.type), size: 20, color: AureonText.primary),
                  const SizedBox(width: 12),
                  Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(i.label, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 13.5)),
                    if (i.type != null) Text(i.type!.toUpperCase(), style: const TextStyle(fontSize: 10, color: AureonText.secondary)),
                  ])),
                  if (active == i.id) const Icon(Icons.check, size: 18, color: AureonGold.c400),
                ]),
              ),
            ),
          ),
        ),
    ]);
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
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      const Text('QUICK ACTIONS', style: TextStyle(fontSize: 11, letterSpacing: 1, color: AureonText.secondary, fontWeight: FontWeight.w600)),
      const SizedBox(height: 8),
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
    ]);
  }

  Widget _tile(BuildContext context, {required IconData icon, required String label, required String? value, required bool on, required VoidCallback onTap}) {
    return SizedBox(
      width: (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2 > 220 ? 220 : (MediaQuery.of(context).size.width - AureonSpacing.md * 2 - 10) / 2,
      child: Material(
        color: on ? AureonGold.c400.withValues(alpha: 0.14) : AureonBase.surface,
        borderRadius: BorderRadius.circular(AureonRadius.md),
        child: InkWell(
          borderRadius: BorderRadius.circular(AureonRadius.md),
          onTap: onTap,
          child: Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(borderRadius: BorderRadius.circular(AureonRadius.md), border: Border.all(color: on ? AureonGold.c400 : AureonBase.hairline)),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
              Icon(icon, size: 18, color: AureonText.primary),
              const SizedBox(height: 4),
              Text(label, style: const TextStyle(fontSize: 12.5)),
              if (value != null) Text(value, style: const TextStyle(fontSize: 11, color: AureonText.secondary)),
            ]),
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

    final nowPlaying = Column(crossAxisAlignment: CrossAxisAlignment.center, children: [
      AvrAlbumArt(url: artworkUrl, name: widget.device.name, playing: playing),
      const SizedBox(height: 14),
      Text(title ?? 'Idle', style: const TextStyle(fontSize: 19, fontWeight: FontWeight.w700), textAlign: TextAlign.center),
      if (artist != null) Text(artist, style: const TextStyle(fontSize: 13.5, color: AureonText.primary), textAlign: TextAlign.center),
      if (album != null) Text(album, style: const TextStyle(fontSize: 12.5, color: AureonText.secondary), textAlign: TextAlign.center),
      const SizedBox(height: 10),
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
      const SizedBox(height: 8),
      AvrTransportRow(
        playing: playing, showPrevious: true, showNext: true, showPlayPause: true,
        onToggle: toggle,
        onPrevious: () => _cmd({'capability': 'media', 'action': 'previous'}),
        onNext: () => _cmd({'capability': 'media', 'action': 'next'}),
      ),
    ]);

    final volumeSection = AvrVolumeDial(volume: volume, volumeDb: volumeDb, muted: muted, onChanged: setVolume, onMuteToggle: setMuted);

    final fields = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
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
    ]);

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
