import 'package:flutter/material.dart'
    show
        Material,
        MaterialType,
        TextField,
        InputDecoration,
        UnderlineInputBorder,
        BorderSide;
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../settings/home_settings_screen.dart' show PairHomeResult;

/// The first-run arrival flow, after the Golden Master's frozen onboarding
/// (`SupremeOS_Onboarding_frozen.html`): Hub detection → Give this residence an identity →
/// Sign in → Your residence is ready.
///
/// What this is, and what it deliberately is not:
/// * **Sign in** is the existing production pairing flow (`pairHomeProvider`, i.e. `realPairHome`:
///   the pairing code, then the Mobile's Ed25519 identity). The Golden Master's Sign in is a
///   passkey flow; this is not that, and the screen never says it is.
/// * **Residence identity** is the existing `PairedHome.displayName`, written through
///   `PairedHomeController.addHome`. There is no account, no email/password, no location field —
///   Flutter has no model for any of those, so they are not drawn.
/// * **Manual connect** (IP/port) is not drawn: pairing finds the Hub through discovery, and there
///   is no manual-address path in production to route it to.
/// * **Demo** appears only when `simulatedResidenceProvider` is non-null (the compile-time
///   `SUPREME_SIMULATED_RESIDENCE` build). Entering it never touches pairing or any Home record.
class OnboardingFlow extends ConsumerStatefulWidget {
  /// Tells the host to keep this flow on screen (true) even though a Home now exists, or release
  /// it (false) so the residence shell takes over.
  final ValueChanged<bool> onHold;
  const OnboardingFlow({super.key, required this.onHold});

  @override
  ConsumerState<OnboardingFlow> createState() => _OnboardingFlowState();
}

enum _Step { detecting, found, noHub, identity, signIn, ready }

// Golden Master onboarding values with no shared token yet (everything else reuses
// `SupremeColorScheme`: ivory #F7F4EE, ink #2D2A25, brass #A78048).
const _ink2 = Color(0xFF5B554C);
const _ink3 = Color(0xFF8A8277);
const _panel = Color(0xFFEFE9DF);
const _errorInk = Color(0xFF9A3B2C);
const _line = Color(0x232D2A25);
const _lineStrong = Color(0x522D2A25);

class _OnboardingFlowState extends ConsumerState<OnboardingFlow> {
  _Step _step = _Step.detecting;
  List<DiscoveredHub> _hubs = const [];
  final _name = TextEditingController();
  final _code = TextEditingController();
  bool _busy = false;
  String? _error;
  int _searchGeneration = 0;

  @override
  void initState() {
    super.initState();
    _search();
  }

  @override
  void dispose() {
    _searchGeneration++; // a search still in flight must not touch a disposed State
    _name.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _search() async {
    final generation = ++_searchGeneration;
    setState(() {
      _step = _Step.detecting;
      _error = null;
    });
    List<DiscoveredHub> hubs;
    try {
      hubs = await ref.read(platformDiscoveryProvider).discoverAllLan();
    } catch (_) {
      hubs =
          const []; // a discovery failure reads as "not found", never as a raw exception
    }
    if (!mounted || generation != _searchGeneration) return;
    setState(() {
      _hubs = hubs;
      _step = hubs.isEmpty ? _Step.noHub : _Step.found;
    });
  }

  String get _suggestedName {
    if (_hubs.isEmpty) return '';
    final n = _hubs.first.identity.displayName.trim();
    return n;
  }

  void _toIdentity() {
    if (_name.text.isEmpty) _name.text = _suggestedName;
    setState(() => _step = _Step.identity);
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
    if (!mounted) return;
    setState(() {
      _busy = false;
      _step = _Step.ready;
    });
  }

  void _enterDemo() => ref.read(demoEnteredProvider.notifier).state = true;

  @override
  Widget build(BuildContext context) {
    final simulated = ref.watch(simulatedResidenceProvider) != null;
    // A transparent Material: the text fields need one, and this surface owns no other.
    return Material(
        type: MaterialType.transparency,
        child: ColoredBox(
          color: SupremeColorScheme.ivory,
          child: SafeArea(
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 560),
                child: SingleChildScrollView(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 28, vertical: 32),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ..._content(),
                      if (simulated && _step != _Step.ready) ...[
                        const SizedBox(height: 24),
                        _DemoEntry(onTap: _enterDemo),
                      ],
                    ],
                  ),
                ),
              ),
            ),
          ),
        ));
  }

  List<Widget> _content() => switch (_step) {
        _Step.detecting => [
            const _Kicker('Your residence'),
            const _Heading('Looking for your Hub…'),
            const _Body('Searching this network.'),
          ],
        _Step.found => [
            const _Kicker('Your residence'),
            const _Heading('Your SupremeOS Hub is here, on this network.'),
            _Body(_suggestedName.isEmpty
                ? 'Give it a name, and SupremeOS will know this residence as yours.'
                : '$_suggestedName. Give it a name, and SupremeOS will know this residence as yours.'),
            const SizedBox(height: 28),
            _Btn('Begin', onTap: _toIdentity),
            const SizedBox(height: 12),
            _Btn('Already known here?',
                quiet: true, onTap: () => setState(() => _step = _Step.signIn)),
          ],
        _Step.noHub => [
            const _Kicker('Your residence'),
            const _Heading('We haven’t found it yet.'),
            const _Body(
                'Make sure your SupremeOS Hub is switched on and connected to the same network as this device.'),
            const SizedBox(height: 28),
            _Btn('Search again', onTap: _search),
          ],
        _Step.identity => [
            const _Kicker('Your residence'),
            const _Heading('Give this residence an identity.'),
            const _Body('The name you’ll know it by.'),
            const SizedBox(height: 24),
            _Field(
              label: 'Residence name',
              hint: 'e.g. Villa Son Vida',
              controller: _name,
              onChanged: (_) => setState(() {}),
            ),
            const SizedBox(height: 28),
            Row(children: [
              _Btn('Back',
                  quiet: true,
                  onTap: () => setState(() => _step = _Step.found)),
              const SizedBox(width: 12),
              Expanded(
                  child: _Btn('Continue',
                      onTap: _name.text.trim().isEmpty
                          ? null
                          : () => setState(() => _step = _Step.signIn))),
            ]),
          ],
        _Step.signIn => [
            const _Kicker('Welcome back'),
            const _Heading('Sign in to your residence.'),
            const _Body(
                'Enter the pairing code from your SupremeOS Hub or the residence’s owner.'),
            const SizedBox(height: 24),
            _Field(
              label: 'Pairing code',
              hint: 'Pairing code',
              controller: _code,
              onChanged: (_) => setState(() {}),
              onSubmitted: (_) => _signIn(),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              Text(_error!,
                  textDirection: TextDirection.ltr,
                  style: _sans(14, _errorInk, height: 1.4)),
            ],
            const SizedBox(height: 28),
            Row(children: [
              _Btn('Back',
                  quiet: true,
                  onTap: _busy
                      ? null
                      : () => setState(() => _step =
                          _name.text.isEmpty ? _Step.found : _Step.identity)),
              const SizedBox(width: 12),
              Expanded(
                  child: _Btn(_busy ? 'Signing in…' : 'Sign in',
                      onTap:
                          _code.text.trim().isEmpty || _busy ? null : _signIn)),
            ]),
            const SizedBox(height: 24),
            const _Body(
                'Not yet known here? The residence’s owner can invite you from SupremeOS.',
                muted: true),
          ],
        _Step.ready => [
            const _Kicker('Welcome home'),
            const _Heading('Your residence is ready.'),
            const _Body('Everything is in place.'),
            const SizedBox(height: 28),
            _Btn('Enter', onTap: () => widget.onHold(false)),
          ],
      };
}

// ── Demo entry (simulation builds only) ──────────────────────────────────────────────────

class _DemoEntry extends StatelessWidget {
  final VoidCallback onTap;
  const _DemoEntry({required this.onTap});

  @override
  Widget build(BuildContext context) => Container(
        width: double.infinity,
        padding: const EdgeInsets.all(14),
        decoration: BoxDecoration(
          color: _panel,
          borderRadius: BorderRadius.circular(4),
          border: Border.all(color: _line),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'A simulated residence. Nothing here is real, and nothing you do reaches a home.',
                textDirection: TextDirection.ltr,
                style: _sans(14, _ink3)),
            const SizedBox(height: 10),
            _Btn('Demo mode', quiet: true, onTap: onTap),
          ],
        ),
      );
}

// ── Golden Master onboarding type and controls ───────────────────────────────────────────

TextStyle _serif(double size, Color color) => TextStyle(
      fontFamily: SupremeFonts.serif,
      package: SupremeFonts.package,
      fontWeight: FontWeight.w300,
      fontSize: size,
      height: 1.04,
      letterSpacing: -0.2,
      color: color,
      decoration: TextDecoration.none,
    );

TextStyle _sans(double size, Color? color, {double height = 1.5}) => TextStyle(
      fontFamily: SupremeFonts.sans,
      package: SupremeFonts.package,
      fontWeight: FontWeight.w400,
      fontSize: size,
      height: height,
      color: color,
      decoration: TextDecoration.none,
    );

class _Kicker extends StatelessWidget {
  final String text;
  const _Kicker(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Text(text.toUpperCase(),
            textDirection: TextDirection.ltr,
            style: _sans(11, SupremeColorScheme.brass)
                .copyWith(letterSpacing: 2.4)),
      );
}

class _Heading extends StatelessWidget {
  final String text;
  const _Heading(this.text);
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(bottom: 14),
        child: Semantics(
          header: true,
          child: Text(text,
              textDirection: TextDirection.ltr,
              style: _serif(38, SupremeColorScheme.ink)),
        ),
      );
}

class _Body extends StatelessWidget {
  final String text;
  final bool muted;
  const _Body(this.text, {this.muted = false});
  @override
  Widget build(BuildContext context) => Text(text,
      textDirection: TextDirection.ltr,
      style: _sans(16, muted ? _ink3 : _ink2));
}

class _Field extends StatelessWidget {
  final String label;
  final String hint;
  final TextEditingController controller;
  final ValueChanged<String>? onChanged;
  final ValueChanged<String>? onSubmitted;
  const _Field({
    required this.label,
    required this.hint,
    required this.controller,
    this.onChanged,
    this.onSubmitted,
  });

  @override
  Widget build(BuildContext context) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label.toUpperCase(),
              textDirection: TextDirection.ltr,
              style: _sans(11, _ink3).copyWith(letterSpacing: 2.0)),
          const SizedBox(height: 6),
          TextField(
            controller: controller,
            onChanged: onChanged,
            onSubmitted: onSubmitted,
            autocorrect: false,
            style: _sans(18, SupremeColorScheme.ink),
            cursorColor: SupremeColorScheme.brass,
            decoration: InputDecoration(
              hintText: hint,
              hintStyle: _sans(18, _ink3),
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              enabledBorder: const UnderlineInputBorder(
                  borderSide: BorderSide(color: _lineStrong)),
              focusedBorder: const UnderlineInputBorder(
                  borderSide: BorderSide(color: SupremeColorScheme.ink)),
            ),
          ),
        ],
      );
}

class _Btn extends StatelessWidget {
  final String text;
  final VoidCallback? onTap;
  final bool quiet;
  const _Btn(this.text, {required this.onTap, this.quiet = false});

  @override
  Widget build(BuildContext context) {
    final enabled = onTap != null;
    return Opacity(
      opacity: enabled ? 1 : .4,
      child: SupremeTappable(
        onTap: onTap ?? () {},
        semanticLabel: text,
        radius: 4,
        child: Container(
          constraints: const BoxConstraints(minHeight: 52, minWidth: 52),
          padding: const EdgeInsets.symmetric(horizontal: 22),
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color: quiet ? null : SupremeColorScheme.ink,
            borderRadius: BorderRadius.circular(4),
            border: quiet ? Border.all(color: _lineStrong) : null,
          ),
          child: Text(text,
              textDirection: TextDirection.ltr,
              style: _sans(15,
                      quiet ? SupremeColorScheme.ink : SupremeColorScheme.ivory)
                  .copyWith(letterSpacing: .3)),
        ),
      ),
    );
  }
}
