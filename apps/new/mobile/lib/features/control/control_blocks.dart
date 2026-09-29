import 'package:flutter/widgets.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// The Golden Master's control blocks (`space.js` lightsBlock / shadesBlock / climateZone /
/// musicBlock), drawn from the Residence State and the command lifecycle. Written once: the
/// Control layer uses them for a scope, the room panel and compact Space page use the lighter
/// rows below — one language, never a per-page copy.
///
/// A block exists only when its devices declare the capability; the value shown is what the
/// devices REPORT, with the request beside it while it is pending; a command that did not land is
/// said in words and the control simply shows the reported value again.

void runCommands(ResidenceView v, List<DeviceCommand> commands) {
  for (final c in commands) {
    try {
      v.tracker.submit(c.deviceId, c.command);
    } on ArgumentError {
      // A command with no verifiable effect is never offered as confirmable; skip rather than fake.
    }
  }
}

String failureWords(CommandFailure f, String what) => switch (f) {
      CommandFailure.timeout => 'The $what didn’t respond.',
      CommandFailure.deviceOffline => 'The $what isn’t responding.',
      CommandFailure.unreachable => 'Your residence couldn’t be reached.',
      CommandFailure.rejected => 'The residence declined that.',
      CommandFailure.superseded => '',
    };

SupremeTextStyles get _t => SupremeTextStyles.resolve(SupremeDensity.comfortable);

Widget _head(String title, {Widget? right, String? read}) => Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 44),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Flexible(
                child: Text(title,
                    style: _t.body.copyWith(
                        fontSize: 15, letterSpacing: .6, color: SupremeColorScheme.text))),
            if (read != null)
              Text(read, style: _t.body.copyWith(fontSize: 13, color: SupremeColorScheme.text2)),
            if (right != null) right,
          ],
        ),
      ),
    );

class _Block extends StatelessWidget {
  final List<Widget> children;
  const _Block(this.children);
  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(0, 20, 0, 16),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: children),
      );
}

Widget? _failure(ResidenceView v, Iterable<String> ids, String capability, String what) {
  final f = failedRecently(v.tracker, ids, capability);
  if (f == null || f == CommandFailure.superseded) return null;
  return SupremeStatus(failureWords(f, what));
}

// ── lights ────────────────────────────────────────────────────────────────────────────────

class LightsBlock extends StatelessWidget {
  final RoomLights lights;
  final ResidenceView view;
  final String title;
  const LightsBlock({super.key, required this.lights, required this.view, this.title = 'Lights'});

  @override
  Widget build(BuildContext context) {
    final l = lights;
    final one = l.lights.length == 1;
    final n = l.online.length;
    final word = one
        ? null
        : l.allOn == true
            ? 'All on'
            : l.allOn == null
                ? '${l.onCount} of $n on'
                : 'All off';
    final fail = _failure(view, [for (final d in l.online) d.id], 'brightness', 'lights') ??
        _failure(view, [for (final d in l.online) d.id], 'onoff', 'lights');
    return _Block([
      _head(title,
          right: l.online.isEmpty
              ? null
              : SupremeSwitch(
                  key: const ValueKey('lights-switch'),
                  on: l.allOn,
                  pending: l.pendingPower,
                  label: one ? l.lights.first.name : 'All lights',
                  word: word,
                  onTap: () => runCommands(view, l.toggle()),
                )),
      if (l.dimmable && l.online.isNotEmpty)
        SupremeSlider(
          key: const ValueKey('lights-level'),
          label: 'Brightness',
          min: 1,
          max: 100,
          value: l.level,
          target: l.pendingLevel,
          readout: l.level == null && l.pendingLevel == null ? 'Off' : null,
          format: (v) => '$v%',
          onCommit: (v) => runCommands(view, l.setLevel(v)),
        ),
      if (l.unresponsive.isNotEmpty)
        SupremeStatus('${l.unresponsive.join(', ')} not responding'),
      if (fail != null) fail,
    ]);
  }
}

// ── curtains & shades ─────────────────────────────────────────────────────────────────────

String shadesWord(int pos) => pos >= 95
    ? 'Open'
    : pos <= 5
        ? 'Drawn'
        : pos <= 35
            ? 'Mostly drawn'
            : pos >= 65
                ? 'Mostly open'
                : 'Partly drawn';

class ShadesBlock extends StatelessWidget {
  final RoomShades shades;
  final ResidenceView view;
  final String title;
  const ShadesBlock({super.key, required this.shades, required this.view, this.title = 'Curtains & shades'});

  @override
  Widget build(BuildContext context) {
    final s = shades;
    final pos = s.position;
    final tgt = s.pendingPosition;
    final named = tgt != null ? (tgt >= 95 ? 'open' : tgt <= 5 ? 'closed' : null) : (pos == null ? null : pos >= 95 ? 'open' : pos <= 5 ? 'closed' : null);
    final fail = _failure(view, [for (final d in s.online) d.id], 'position', 'curtains');
    return _Block([
      _head(title, read: s.online.isEmpty || pos == null ? 'Not responding' : shadesWord(pos)),
      if (s.online.isNotEmpty) ...[
        SupremeOptions<String>(
          label: 'Curtains and shades',
          options: const ['open', 'closed'],
          name: (o) => o == 'open' ? 'Open' : 'Closed',
          value: pos == null ? null : pos >= 95 ? 'open' : pos <= 5 ? 'closed' : null,
          pending: tgt != null ? named : null,
          onSelect: (o) => runCommands(view, s.to(o == 'open' ? 100 : 0)),
        ),
        SupremeSlider(
          key: const ValueKey('shades-position'),
          label: 'Position',
          min: 0,
          max: 100,
          value: pos,
          target: tgt,
          format: (v) => v >= 95 ? 'Open' : v <= 5 ? 'Closed' : '$v% open',
          onCommit: (v) => runCommands(view, s.to(v)),
        ),
      ],
      if (s.online.isNotEmpty && s.online.length < s.shades.length)
        SupremeStatus('${s.unresponsive.join(', ')} not responding'),
      if (fail != null) fail,
    ]);
  }
}

// ── climate ───────────────────────────────────────────────────────────────────────────────

String fmtC(num t) => '${(t * 10).round() / 10}°';

class ClimateBlock extends StatelessWidget {
  final RoomClimate zone;
  final ResidenceView view;
  final String title;
  const ClimateBlock({super.key, required this.zone, required this.view, this.title = 'Climate'});

  @override
  Widget build(BuildContext context) {
    final z = zone;
    final shownTarget = z.pendingTargetC ?? z.targetC;
    final now = z.ambientC == null ? null : fmtC(z.ambientC!);
    final status = !z.online
        ? 'Not responding'
        : !z.on
            ? (now != null ? '$now in the room · off' : 'Off')
            : 'Set${now != null ? ' · $now in the room now' : ''}';
    final fail = _failure(view, [z.device.id], 'temperature', z.device.name.toLowerCase());
    return _Block([
      _head(title,
          right: z.online && z.modes.contains('off') || z.online && z.mode != null
              ? SupremeSwitch(
                  key: ValueKey('climate-power-${z.device.id}'),
                  on: z.on,
                  pending: z.pendingPower,
                  label: z.device.name,
                  showWord: true,
                  onTap: () => runCommands(view, [z.power(!z.on)]),
                )
              : null),
      Row(children: [
        Expanded(
          child: SupremeValue(
            z.online && z.on && shownTarget != null ? fmtC(shownTarget) : (now ?? '—'),
            pending: z.pendingTargetC != null,
            quiet: !(z.online && z.on && shownTarget != null),
          ),
        ),
        if (z.online && z.on && z.canSetTarget)
          SupremeStepper(
            label: z.device.name,
            onDown: z.stepped(-1) == null ? null : () => runCommands(view, [z.stepped(-1)!]),
            onUp: z.stepped(1) == null ? null : () => runCommands(view, [z.stepped(1)!]),
          ),
      ]),
      SupremeStatus(status,
          pending: z.pendingTargetC != null ? 'setting ${fmtC(z.pendingTargetC!)}…' : null),
      if (fail != null) fail,
    ]);
  }
}

// ── music ─────────────────────────────────────────────────────────────────────────────────

class MusicBlock extends StatelessWidget {
  final RoomMusic music;
  final ResidenceView view;
  final String title;
  const MusicBlock({super.key, required this.music, required this.view, this.title = 'Music'});

  @override
  Widget build(BuildContext context) {
    final m = music;
    final playing = m.pendingPlaying ?? m.playing;
    final status = !m.online
        ? 'Not responding'
        : m.playing && m.title != null
            ? '“${m.title}”${m.artist != null ? ' · ${m.artist}' : ''}'
            : 'Quiet';
    final fail = _failure(view, [m.device.id], 'media', m.device.name.toLowerCase());
    return _Block([
      _head(title,
          right: m.online
              ? SupremeAct(
                  playing ? 'Pause' : 'Play',
                  key: ValueKey('music-toggle-${m.device.id}'),
                  pending: m.pendingPlaying != null,
                  fontSize: 15,
                  onTap: () => runCommands(view, [m.toggle()]),
                )
              : null),
      SupremeStatus(status),
      if (m.online && m.volume != null)
        SupremeSlider(
          key: ValueKey('music-volume-${m.device.id}'),
          label: 'Volume',
          min: 0,
          max: 100,
          value: m.volume,
          target: m.pendingVolume,
          format: (v) => '$v%',
          onCommit: (v) => runCommands(view, [m.setVolume(v)]),
        ),
      if (fail != null) fail,
    ]);
  }
}

// ── the room, now — one line per system (compact surfaces and room panels) ────────────────

class ImmediateRows extends StatelessWidget {
  final String spaceId;
  final ResidenceView view;
  const ImmediateRows({super.key, required this.spaceId, required this.view});

  @override
  Widget build(BuildContext context) {
    final devs = view.snapshot.devicesIn(spaceId);
    final lights = RoomLights.of(devs, view.inFlight);
    final shades = RoomShades.of(devs, view.inFlight);
    final climates = [for (final z in RoomClimate.allOf(devs, view.inFlight)) if (z.online) z];
    final music = [for (final m in RoomMusic.allOf(devs, view.inFlight)) if (m.online) m];
    final rows = <Widget>[];

    if (lights != null && lights.online.isNotEmpty) {
      final n = lights.online.length;
      rows.add(_Row(
        k: 'lights',
        name: 'Lights',
        word: lights.allOn == false
            ? 'Off'
            : lights.allOn == true
                ? (n == 1 ? 'On' : 'All on')
                : '${lights.onCount} of $n on',
        control: SupremeSwitch(
            on: lights.allOn,
            pending: lights.pendingPower,
            label: 'Lights',
            showWord: false,
            onTap: () => runCommands(view, lights.toggle())),
      ));
    }
    if (shades != null && shades.online.isNotEmpty && shades.position != null) {
      final tgt = shades.pendingPosition;
      final open = (tgt ?? shades.position!) >= 50;
      rows.add(_Row(
        k: 'shades',
        name: 'Curtains',
        word: tgt != null ? (tgt >= 50 ? 'Opening…' : 'Closing…') : shadesWord(shades.position!),
        control: SupremeAct(open ? 'Draw' : 'Open',
            pending: tgt != null,
            fontSize: 15,
            onTap: () => runCommands(view, shades.to(open ? 0 : 100))),
      ));
    }
    for (final z in climates) {
      final t = z.pendingTargetC ?? z.targetC;
      rows.add(_Row(
        k: 'climate-${z.device.id}',
        name: 'Climate',
        word: z.on && t != null ? '${fmtC(t)}${z.pendingTargetC != null ? ' …' : ''}' : 'Off',
        control: z.on && z.canSetTarget
            ? SupremeStepper(
                label: z.device.name,
                onDown: z.stepped(-1) == null ? null : () => runCommands(view, [z.stepped(-1)!]),
                onUp: z.stepped(1) == null ? null : () => runCommands(view, [z.stepped(1)!]))
            : SupremeSwitch(
                on: false,
                pending: z.pendingPower,
                label: z.device.name,
                showWord: false,
                onTap: () => runCommands(view, [z.power(true)])),
      ));
    }
    for (final m in music) {
      final playing = m.pendingPlaying ?? m.playing;
      rows.add(_Row(
        k: 'music-${m.device.id}',
        name: 'Music',
        word: m.pendingPlaying != null ? (m.pendingPlaying! ? 'Starting…' : 'Pausing…') : m.playing ? 'Playing' : 'Quiet',
        control: SupremeAct(playing ? 'Pause' : 'Play',
            pending: m.pendingPlaying != null,
            fontSize: 15,
            onTap: () => runCommands(view, [m.toggle()])),
      ));
    }
    if (rows.isEmpty) return const SizedBox.shrink();
    return Semantics(
      label: 'The room, now',
      container: true,
      child: Container(
        margin: const EdgeInsets.only(top: 22),
        constraints: const BoxConstraints(maxWidth: 560),
        decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: SupremeColorScheme.rule))),
        child: Column(children: rows),
      ),
    );
  }
}

class _Row extends StatelessWidget {
  final String k;
  final String name;
  final String word;
  final Widget control;
  const _Row({required this.k, required this.name, required this.word, required this.control});
  @override
  Widget build(BuildContext context) => Container(
        key: ValueKey('imm-$k'),
        constraints: const BoxConstraints(minHeight: 60),
        decoration: const BoxDecoration(
            border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
        child: Row(children: [
          SizedBox(
            width: 96,
            child: Text(name.toUpperCase(),
                style: _t.body.copyWith(
                    fontSize: 12, letterSpacing: 2.2, color: const Color(0x8FF7F4EE))),
          ),
          const SizedBox(width: 12),
          Expanded(
              child: Text(word,
                  style: _t.name.copyWith(
                      fontSize: 22, fontFeatures: const [FontFeature.tabularFigures()]))),
          control,
        ]),
      );
}
