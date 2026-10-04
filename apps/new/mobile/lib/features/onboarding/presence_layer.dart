import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

import 'presence_engine.dart';

/// What the onboarding says to Presence: the Hub really answered ([hubResponded]), nobody answered
/// ([stop] — SupremeOS stays alone), or the flow is closing on the resting mark under the
/// residence's name ([rest]). Mirrors `SupremeOSPresence.{hubResponded,stop,rest}`.
class PresenceController {
  _PresenceLayerState? _s;
  void hubResponded() => _s?._hubResponded();
  void stop() => _s?._stop();
  void rest(String title) => _s?._rest(title);
}

/// The full-screen Presence layer: the Golden Master's boot choreography, drawn by
/// [PresencePainter] against a [PresenceClock]. Under reduced motion there is no choreography — the
/// settled mark is shown, and [onDone] fires once the Hub has answered.
class PresenceLayer extends StatefulWidget {
  final PresenceController controller;
  final bool reduced;

  /// The choreography has finished (the engine's `onDone`).
  final VoidCallback onDone;
  const PresenceLayer(
      {super.key,
      required this.controller,
      required this.reduced,
      required this.onDone});

  @override
  State<PresenceLayer> createState() => _PresenceLayerState();
}

class _PresenceLayerState extends State<PresenceLayer>
    with SingleTickerProviderStateMixin {
  final _clock = PresenceClock();
  Ticker? _ticker;
  Duration _last = Duration.zero;
  bool _done = false;
  String _title = 'Welcome';
  bool _resting = false;

  @override
  void initState() {
    super.initState();
    widget.controller._s = this;
    if (!widget.reduced) {
      _ticker = createTicker(_onTick)..start();
    }
  }

  void _onTick(Duration elapsed) {
    final dt = (elapsed - _last).inMicroseconds / 1000.0;
    _last = elapsed;
    final finished = _clock.tick(dt);
    setState(() {});
    if (finished && !_done) {
      _done = true;
      _ticker?.stop();
      widget.onDone();
    }
  }

  void _hubResponded() {
    _clock.hubResponded();
    if (widget.reduced && !_done) {
      _done = true;
      setState(() {});
      widget.onDone();
    }
  }

  void _stop() {
    _clock.stop();
    _ticker?.stop();
  }

  /// The engine's `rest(title)`: its own final frame — the resting mark — with the name beneath it.
  void _rest(String title) {
    _ticker?.stop();
    setState(() {
      _title = title;
      _resting = true;
    });
  }

  @override
  void dispose() {
    if (widget.controller._s == this) widget.controller._s = null;
    _ticker?.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final timeline = _resting
        ? (PresenceTimeline()..place(PresenceTimeline.minStill))
        : _clock.timeline.copy();
    final t = _resting ? timeline.end : _clock.t;
    return Semantics(
      label: 'SupremeOS Presence',
      liveRegion: true,
      child: CustomPaint(
        painter: PresencePainter(
          t: t,
          timeline: timeline,
          title: _title,
          reduced: widget.reduced,
        ),
        child: const SizedBox.expand(),
      ),
    );
  }
}
