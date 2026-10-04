import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart' show Material, MaterialType;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../data/home_location.dart';
import '../../data/manual_hub_store.dart' show validateHubIp, validateHubPort;
import '../../main.dart';
import '../settings/home_settings_screen.dart' show PairHomeResult;
import 'field_panel.dart';
import 'onboarding_tokens.dart';
import 'presence_layer.dart';

/// The first-run arrival flow, after the Golden Master's frozen onboarding
/// (`SupremeOS_Onboarding_frozen.html`, embedded byte-for-byte in `SupremeOS-10.html`): the Presence
/// boot choreography while the Hub is found → Welcome (page 1) → Give this residence an identity →
/// Sign in → Welcome home. Its CSS values are used as they are (`onboarding_tokens.dart`).
///
/// What this is, and what it deliberately is not:
/// * **Sign in** is the existing production pairing flow (`pairHomeProvider`, i.e. `realPairHome`:
///   the pairing code, then the Mobile's Ed25519 identity). The Golden Master's Sign in is a
///   passkey / email flow; this is not that, and the screen never says it is.
/// * **Residence identity** is the existing `PairedHome.displayName`, written through
///   `PairedHomeController.addHome`. There is no account, no email/password, no location field —
///   Flutter has no model for any of those, so they are not drawn (the Golden Master's "Identity"
///   account step and the location/daylight rows are therefore absent).
/// * **Manual connect** (IP/port) is not drawn: pairing finds the Hub through discovery, and there
///   is no manual-address path in production to route it to.
/// * **Demo** appears only on page 1 (and its "not found yet" variant) and only when
///   `simulatedResidenceProvider` is non-null (the compile-time `SUPREME_SIMULATED_RESIDENCE`
///   build). Entering it never touches pairing or any Home record.
class OnboardingFlow extends ConsumerStatefulWidget {
  /// Tells the host to keep this flow on screen (true) even though a Home now exists, or release
  /// it (false) so the residence shell takes over.
  final ValueChanged<bool> onHold;
  const OnboardingFlow({super.key, required this.onHold});

  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

enum _Step { welcome, noHub, identity, signIn, ready }

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  _Step _step = _Step.welcome;

  /// Presence owns the first seconds: the Hub is searched for while it plays, and Welcome appears
  /// when it has finished (or "not found" after a quiet pause).
  bool _booting = true;
  bool _entering = false;
  bool _resting = false;
  Key _presenceKey = UniqueKey();
  final _presence = PresenceController();

  List<DiscoveredHub> _hubs = const [];
  final _name = TextEditingController();
  final _code = TextEditingController();

  // The residence's location (the Hub keeps it; the sun is computed from it).
  final _location = TextEditingController();
  String? _locationError;
  bool _locating = false;
  Place? _place;
  bool _locationNotSaved = false;

  // "Or connect manually" on the not-found screen.
  bool _manualOpen = false;
  bool _connecting = false;
  final _ip = TextEditingController();
  final _port = TextEditingController(text: '${SupremeOSHubDefaults.defaultPort}');
  String? _ipError, _portError, _manualMain, _manualSub;
  ({String host, int port})? _manualHub;
  bool _busy = false;
  String? _error;
  String? _nameError;
  int _generation = 0;
  bool _setup = false; // the identity step was completed (vs. "Already known here?")
  bool _started = false;
  final _timers = <Timer>[];

  bool get _reduced => MediaQuery.disableAnimationsOf(context);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_started) return;
    _started = true;
    _launch();
  }

  @override
  void dispose() {
    _generation++; // a search still in flight must not touch a disposed State
    for (final t in _timers) {
      t.cancel();
    }
    _name.dispose();
    _location.dispose();
    _code.dispose();
    _ip.dispose();
    _port.dispose();
    super.dispose();
  }

  void _later(Duration d, VoidCallback f) {
    if (d == Duration.zero) {
      f();
      return;
    }
    late final Timer t;
    t = Timer(d, () {
      _timers.remove(t);
      if (mounted) f();
    });
    _timers.add(t);
  }

  /// `launch()` — Presence reaches out and holds in stillness while discovery searches. Found →
  /// the residence answers inside the choreography → Welcome. Not found → Presence stops, a quiet
  /// pause, then the recovery state settles in.
  Future<void> _launch() async {
    final generation = ++_generation;
    setState(() {
      _booting = true;
      _error = null;
      _presenceKey = UniqueKey();
    });
    List<DiscoveredHub> hubs;
    try {
      hubs = await ref.read(platformDiscoveryProvider).discoverAllLan();
    } catch (_) {
      hubs =
          const []; // a discovery failure reads as "not found", never as a raw exception
    }
    if (!mounted || generation != _generation) return;
    _hubs = hubs;
    if (hubs.isNotEmpty) {
      _presence.hubResponded();
    } else {
      _presence.stop();
      _later(_reduced ? Duration.zero : const Duration(milliseconds: 700), () {
        if (generation != _generation) return;
        setState(() {
          _booting = false;
          _step = _Step.noHub;
        });
      });
    }
  }

  /// `PRESENCE.onDone` → a beat, then the app is shown and Welcome opens.
  void _presenceDone() {
    final generation = _generation;
    _later(
        _reduced
            ? const Duration(milliseconds: 600)
            : const Duration(milliseconds: 1400), () {
      if (generation != _generation || _hubs.isEmpty) return;
      setState(() {
        _booting = false;
        _step = _Step.welcome;
      });
    });
  }

  void _go(_Step s) => setState(() {
        _step = s;
        _error = null;
      });

  void _toIdentity() => _go(_Step.identity);

  Future<void> _submitIdentity() async {
    if (_locating) return;
    final nameEmpty = _name.text.trim().isEmpty;
    final placeEmpty = _location.text.trim().isEmpty;
    if (nameEmpty || placeEmpty) {
      setState(() {
        if (nameEmpty) _nameError = 'Please give your residence a name.';
        if (placeEmpty) _locationError = 'Please enter the location.';
      });
      return;
    }
    // The place the person typed, found: coordinates and a time zone for the sun.
    setState(() {
      _locating = true;
      _locationError = null;
    });
    Place? place;
    try {
      place = await ref.read(placeLookupProvider)(_location.text.trim());
    } on PlaceLookupUnavailable {
      if (!mounted) return;
      setState(() {
        _locating = false;
        _locationError =
            'Couldn’t reach the place search. Check this device’s internet connection and try again.';
      });
      return;
    }
    if (!mounted) return;
    if (place == null) {
      setState(() {
        _locating = false;
        _locationError = 'We couldn’t find that place. Try the city and country, e.g. Palma, Spain.';
      });
      return;
    }
    _place = place;
    _setup = true;
    setState(() => _locating = false);
    _go(_Step.signIn);
  }

  Future<void> _signIn() async {
    final code = _code.text.trim();
    if (code.isEmpty || _busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final PairHomeResult result;
    try {
      result = await ref.read(pairHomeProvider)(code);
    } on StateError catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = e.message;
      });
      return;
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'That didn’t work. Check the pairing code and try again.';
      });
      return;
    }
    final controller = ref.read(pairedHomeControllerProvider);
    final name = _name.text.trim().isNotEmpty
        ? _name.text.trim()
        : (result.suggestedDisplayName?.trim().isNotEmpty ?? false)
            ? result.suggestedDisplayName!.trim()
            : 'Home';
    // Pairing succeeded, so the Home now exists; keep this flow up until "Enter".
    widget.onHold(true);
    if (!controller.homes.any((h) => h.hubId == result.hubId)) {
      await controller.addHome(
          hubId: result.hubId, projectId: result.projectId, displayName: name);
    }
    // The residence told where it is: the Hub keeps the location, every device reads it from there.
    final place = _place;
    var notSaved = false;
    if (_setup && place != null) {
      try {
        await ref.read(homeLocationWriterProvider)(result.hubId, place);
      } catch (_) {
        notSaved = true; // said on the next screen, never silently dropped
      }
    }
    // A Hub the person addressed by hand is now known by its identity, so it is found again by it.
    final manual = _manualHub;
    if (manual != null) {
      await ref.read(manualHubStoreProvider).bindHubId(manual.host, manual.port, result.hubId);
    }
    if (!mounted) return;
    setState(() {
      _busy = false;
      _locationNotSaved = notSaved;
      _step = _Step.ready;
    });
  }

  /// The original's manual connect: check the address answers, remember it, then let Presence play
  /// the recognition and open Welcome as it does for a Hub that was found.
  Future<void> _connectManually() async {
    if (_connecting) return;
    final ipError = validateHubIp(_ip.text), portError = validateHubPort(_port.text);
    setState(() {
      _ipError = ipError;
      _portError = portError;
      _manualMain = _manualSub = null;
    });
    if (ipError != null || portError != null) return;
    final host = _ip.text.trim(), port = int.parse(_port.text.trim());
    setState(() => _connecting = true);
    bool ok;
    try {
      ok = await ref.read(hubProbeProvider)(host, port);
    } catch (_) {
      ok = false;
    }
    if (!mounted) return;
    if (!ok) {
      setState(() {
        _connecting = false;
        _manualMain = 'The residence didn’t respond at $host:$port. ';
        _manualSub = 'Check that the SupremeOS Hub is switched on and connected to this network.';
      });
      return;
    }
    await ref.read(manualHubStoreProvider).add(host, port);
    _manualHub = (host: host, port: port);
    if (!mounted) return;
    setState(() => _connecting = false);
    _later(_reduced ? Duration.zero : const Duration(milliseconds: 700), _launch);
  }

  void _enterDemo() {
    ref.read(arrivalRequestedProvider.notifier).state = false;
    ref.read(demoEnteredProvider.notifier).state = true;
  }

  String get _residenceName => _name.text.trim().isNotEmpty && _setup
      ? _name.text.trim()
      : 'your residence';

  /// Enter — the onboarding quietly withdraws; the story closes where Presence ended (one mark,
  /// now named); then the residence opens.
  void _enter() {
    if (_entering) return;
    final name = _residenceName;
    setState(() => _entering = true);
    _later(_reduced ? Duration.zero : const Duration(milliseconds: 700), () {
      _presence.rest(name);
      setState(() => _resting = true);
    });
    _later(_reduced ? Duration.zero : const Duration(milliseconds: 2400), () {
      ref.read(arrivalRequestedProvider.notifier).state = false;
      widget.onHold(false);
    });
  }

  PanelGoal get _panelGoal => switch (_step) {
        _Step.identity =>
          PanelGoal(b: _name.text.trim().isEmpty ? 0 : 1),
        _Step.signIn || _Step.ready => PanelGoal.resting,
        _ => PanelGoal.alone,
      };

  @override
  Widget build(BuildContext context) {
    final simulated = ref.watch(simulatedResidenceProvider) != null;
    final reduced = _reduced;
    return Material(
      type: MaterialType.transparency,
      child: ColoredBox(
        color: Gm.bg,
        child: Stack(children: [
          // The app: header, field panel and the screens. Inert while Presence is on.
          ExcludeSemantics(
            excluding: _booting || _resting,
            child: IgnorePointer(
              ignoring: _booting || _entering,
              child: _Stage(
                step: _step,
                entering: _entering,
                reduced: reduced,
                panelGoal: _panelGoal,
                // No page exists while Presence plays: Welcome is built when it hands over.
                children: _booting ? const [] : _content(simulated),
              ),
            ),
          ),
          // Presence: fades out when the app is shown (opacity .6s), back in to close the story.
          Positioned.fill(
            child: IgnorePointer(
              child: AnimatedOpacity(
                opacity: (_booting || _resting) ? 1 : 0,
                duration: reduced ? Duration.zero : const Duration(milliseconds: 600),
                curve: Gm.ease,
                child: ExcludeSemantics(
                  excluding: !_booting && !_resting,
                  child: PresenceLayer(
                    key: _presenceKey,
                    controller: _presence,
                    reduced: reduced,
                    onDone: _presenceDone,
                  ),
                ),
              ),
            ),
          ),
        ]),
      ),
    );
  }

  /// `#f-hub`: IP and port, a hint, and Connect — the original's, with its own words.
  Widget _manualForm() => Builder(builder: (context) {
    final m = GmScope.of(context);
    final ip = GmField(
      label: 'IP address',
      hint: '192.168.1.20',
      controller: _ip,
      error: _ipError,
      onChanged: (_) => setState(() => _ipError = null),
      onSubmitted: (_) => _connectManually(),
    );
    final port = GmField(
      label: 'Port',
      hint: '${SupremeOSHubDefaults.defaultPort}',
      controller: _port,
      error: _portError,
      onChanged: (_) => setState(() => _portError = null),
      onSubmitted: (_) => _connectManually(),
    );
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
      if (_manualMain != null) GmFormNote(main: _manualMain!, sub: _manualSub ?? ''),
      if (m.phone) ...[ip, port] else Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(child: ip),
        const SizedBox(width: 24),
        SizedBox(width: 150, child: port),
      ]),
      const GmLede('You’ll find the address in your router’s list of connected devices, or on the label underneath the Hub.'),
      GmActions([
        const SizedBox.shrink(),
        GmButton(_connecting ? 'Connecting…' : 'Connect',
            quiet: true, arrow: true, busy: _connecting, onTap: _connecting ? null : _connectManually),
      ], top: 24),
    ]);
  });

  List<Widget> _content(bool simulated) {
    final demo = simulated && (_step == _Step.welcome || _step == _Step.noHub);
    return switch (_step) {
      _Step.welcome => [
          const GmMeta('Your SupremeOS Hub is here, on this network.'),
          const GmHeading('Your residence\nis here.', h1: true),
          const GmLede(
              'Give it a name, and SupremeOS will know this residence as yours.'),
          GmActions([GmButton('Begin', onTap: _toIdentity, arrow: true)]),
          GmAlt(
              text: 'Already known here? ',
              link: 'Sign in',
              onTap: () => _go(_Step.signIn)),
          if (demo) _DemoEntry(onTap: _enterDemo),
        ],
      _Step.noHub => [
          const GmEyebrow('Your residence'),
          const GmHeading('We haven’t found it yet.'),
          const GmLede(
              'Make sure your SupremeOS Hub is switched on and connected to the same network as this device.'),
          GmActions(
              [GmButton('Search again', onTap: _launch, arrow: true)],
              top: 30),
          GmDisclose(
              label: 'or connect manually',
              open: _manualOpen,
              onTap: () => setState(() => _manualOpen = !_manualOpen)),
          if (_manualOpen) _manualForm(),
          if (demo) _DemoEntry(onTap: _enterDemo),
        ],
      _Step.identity => [
          const GmEyebrow('Your residence'),
          const GmHeading('Give this residence an identity.'),
          const GmLede('The name you’ll know it by. Its location lets light and time follow the day outside.'),
          const GmMeta('Connected to your SupremeOS Hub on this network.',
              top: 22, bottom: 0),
          GmForm([
            GmField(
              label: 'Residence name',
              hint: 'e.g. Villa Son Vida',
              controller: _name,
              error: _nameError,
              onChanged: (_) => setState(() {
                if (_nameError != null) {
                  _nameError = _name.text.trim().isEmpty
                      ? 'Please give your residence a name.'
                      : null;
                }
              }),
              onSubmitted: (_) => _submitIdentity(),
            ),
            GmField(
              label: 'Location',
              hint: 'City, country',
              controller: _location,
              error: _locationError,
              onChanged: (_) => setState(() {
                if (_locationError != null) _locationError = null;
              }),
              onSubmitted: (_) => _submitIdentity(),
            ),
            GmActions([
              GmBack(onTap: () => _go(_Step.welcome)),
              GmButton(_locating ? 'Finding…' : 'Continue',
                  onTap: _locating ? null : _submitIdentity, arrow: true, busy: _locating),
            ], top: 36),
          ]),
        ],
      _Step.signIn => [
          const GmEyebrow('Welcome back'),
          const GmHeading('Sign in to your residence.'),
          GmForm([
            GmField(
              label: 'Pairing code',
              hint: 'Pairing code',
              controller: _code,
              hintBelow:
                  'Enter the six-digit code from SupremeOS on the web: Settings, Security & sign-in, Pair a phone.',
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _signIn(),
            ),
            if (_error != null) GmFormError(_error!),
            GmActions([
              GmBack(
                  onTap: _busy
                      ? null
                      : () => _go(_setup ? _Step.identity : _Step.welcome)),
              GmButton(_busy ? 'Signing in…' : 'Sign in',
                  quiet: true,
                  arrow: true,
                  busy: _busy,
                  onTap: _code.text.trim().isEmpty || _busy ? null : _signIn),
            ], top: 36),
          ], top: 34),
          const GmAlt(
              text:
                  'Not yet known here? The residence’s owner can invite you from SupremeOS.'),
        ],
      _Step.ready => [
          GmEyebrow(_setup ? 'Welcome home' : 'Welcome back'),
          GmHeading(_setup
              ? '${_name.text.trim()} is yours.'
              : 'Your residence knows you.'),
          GmLede(_setup
              ? 'SupremeOS now knows your residence — and you.'
              : 'Everything is as you left it.'),
          if (_locationNotSaved)
            const GmAlt(
                text:
                    'The location couldn’t be saved to the Hub just now, so the sun will not follow it yet.'),
          GmActions([
            GmButton(_setup ? 'Enter ${_name.text.trim()}' : 'Enter',
                onTap: _enter, arrow: true)
          ]),
        ],
    };
  }
}

// ── Demo entry (simulation builds only) ──────────────────────────────────────────────────

class _DemoEntry extends StatelessWidget {
  final VoidCallback onTap;
  const _DemoEntry({required this.onTap});

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 28),
        child: Align(
          alignment: Alignment.centerLeft,
          child: GmButton('Demo mode', quiet: true, onTap: onTap),
        ),
      );
}

// ── Stage: header · field panel · screens, composed as the Golden Master's CSS does ─────

class _Stage extends StatelessWidget {
  final _Step step;
  final bool entering;
  final bool reduced;
  final PanelGoal panelGoal;
  final List<Widget> children;
  const _Stage({
    required this.step,
    required this.entering,
    required this.reduced,
    required this.panelGoal,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final w = c.maxWidth, h = c.maxHeight;
      final m = GmMetrics(w, h);
      final fade = Duration(milliseconds: reduced ? 0 : 700);

      final header = AnimatedOpacity(
        opacity: entering ? 0 : 1,
        duration: fade,
        curve: Gm.ease,
        child: Container(
          padding: EdgeInsets.symmetric(horizontal: m.gutter, vertical: m.headerPad),
          decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Gm.line))),
          child: Align(
            alignment: Alignment.centerLeft,
            child: Semantics(
              label: 'SupremeOS',
              excludeSemantics: true,
              child: Text('SUPREMEOS',
                  textDirection: TextDirection.ltr,
                  style: Gm.sans(12, Gm.ink, weight: FontWeight.w400)
                      .copyWith(letterSpacing: .28 * 12)),
            ),
          ),
        ),
      );

      final screens = AnimatedOpacity(
        opacity: entering ? 0 : 1,
        duration: fade,
        curve: Gm.ease,
        child: _EnterAnimation(
          key: ValueKey(step),
          reduced: reduced,
          settle: step == _Step.noHub,
          child: Column(
              crossAxisAlignment: CrossAxisAlignment.start, children: children),
        ),
      );

      Widget panel(double width) {
        final height = m.panelHeight(width);
        return SizedBox(
          width: width,
          height: height,
          child: ClipRRect(
            borderRadius: BorderRadius.circular(4),
            child: ColoredBox(
              color: entering ? Gm.bg : Gm.panel,
              child: OnboardingFieldPanel(goal: panelGoal, reduced: reduced),
            ),
          ),
        );
      }

      final inner = math.max(0.0, math.min(w, 1760.0) - 2 * m.gutter);
      Widget body;
      if (m.singleColumn) {
        // The two grid rows stretch to the page (see GmGridRows); the page's minimum height
        // reaches it through the padding.
        body = Padding(
          padding: EdgeInsets.symmetric(horizontal: m.gutter, vertical: m.mainPadV),
          child: GmGridRows(gap: 28, first: panel(inner), second: screens),
        );
      } else {
        final gap = m.columnGap;
        final gapW = math.min(gap, inner);
        final avail = inner - gapW;
        final left = avail * m.leftFr / (m.leftFr + 1);
        final right = avail - left;
        body = Padding(
          padding: EdgeInsets.symmetric(horizontal: m.gutter, vertical: m.mainPadV),
          child: Align(
            alignment: m.shortLandscape ? Alignment.topCenter : Alignment.center,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 1760),
              child: Row(
                crossAxisAlignment: m.shortLandscape
                    ? CrossAxisAlignment.start
                    : CrossAxisAlignment.center,
                children: [
                  SizedBox(width: left, child: panel(left)),
                  SizedBox(width: gapW),
                  SizedBox(
                      width: right,
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: ConstrainedBox(
                            constraints:
                                BoxConstraints(maxWidth: m.screensMaxWidth),
                            child: screens),
                      )),
                ],
              ),
            ),
          ),
        );
      }

      // `.app { min-height: 100dvh; grid-template-rows: auto 1fr }` — the header, then the main
      // area filling what is left (and scrolling when the content is taller).
      return GmScope(
        metrics: m,
        child: CustomScrollView(slivers: [
          SliverToBoxAdapter(child: header),
          SliverFillRemaining(
            hasScrollBody: false,
            // One column: the body takes the page's height itself (its rows stretch to it).
            child: m.singleColumn
                ? body
                : Align(
                    alignment: m.shortLandscape
                        ? Alignment.topCenter
                        : Alignment.center,
                    child: body),
          ),
        ]),
      );
    });
  }
}

/// `.screen.active { animation: enter .42s cubic-bezier(.2,.7,.2,1) both }` — opacity 0→1 and a
/// rise of 8; the recovery screen settles with opacity alone over .9s.
class _EnterAnimation extends StatelessWidget {
  final bool reduced;
  final bool settle;
  final Widget child;
  const _EnterAnimation(
      {super.key,
      required this.reduced,
      required this.settle,
      required this.child});

  @override
  Widget build(BuildContext context) => TweenAnimationBuilder<double>(
        tween: Tween(begin: reduced ? 1 : 0, end: 1),
        duration: reduced
            ? Duration.zero
            : Duration(milliseconds: settle ? 900 : 420),
        curve: Gm.ease,
        builder: (context, t, c) => Opacity(
          opacity: t,
          child: Transform.translate(
              offset: Offset(0, settle ? 0 : 8 * (1 - t)), child: c),
        ),
        child: child,
      );
}
