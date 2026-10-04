import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import '../_shared/residence_presentation.dart';
import '../devices/devices_layer.dart';

/// Home — what is the residence like right now? (Golden Master `home.js`): the architectural cover
/// page. Where am I · what is it like · does anything matter. One sentence, a few signals, the
/// Experience it feels like, and a quiet note only when something is out. Every word is derived
/// from confirmed device state (`describeHome`); nothing here is a dashboard and nothing is
/// stored.
///
/// The sun's line sits under the name when the Hub holds a location. NOT YET (flagged in the
/// implementation map): protection ("Secure"/"Protected" — no arming/contact contract), the
/// watch glance and the residence panel's room-by-room map (Phases 4).
class HomeScreen extends ConsumerWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(residenceViewProvider).valueOrNull;
    final hour = ref.watch(residenceHourProvider);
    final homes = ref.watch(pairedHomeControllerProvider);
    final profile = SurfaceScope.of(context);
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final snap = view?.snapshot;
    final w = profile.widthDp;
    final phone = profile.skeleton == SurfaceSkeleton.phone;
    final m = PageGeometry.of(profile);
    final top = ShellInsets.of(context).top + m.top;
    final watch = profile.skeleton == SurfaceSkeleton.watch;

    final name = (snap?.name.isNotEmpty ?? false)
        ? snap!.name
        : homes.activeHome?.displayName ?? '';
    final loaded = snap != null && snap.loaded;
    final d = loaded ? describeHome(snap, hour: hour, commands: view!.inFlight, activations: view.activating) : null;
    final settingWhole = loaded
        ? [
            for (final e in snap.experiences)
              if (experienceStatus(e, snap, commands: view!.inFlight, activations: view.activating).phase ==
                  ExperiencePhase.becoming)
                e
          ].firstOrNull
        : null;
    final look = lookFor(loaded ? lightOf(snap.devices.values) : const RoomLight(lightsTotal: 0, lightsOn: 0, level: 0, kelvin: null));
    final stale = loaded && snap.reachable == false;

    final nameSize = watch
        ? 26.0
        : phone
            ? (w * .12).clamp(40.0, 56.0)
            : (w * .064).clamp(48.0, 92.0);

    return Stack(
      key: const ValueKey('home-page'),
      fit: StackFit.expand,
      children: [
        // The residence's own photograph (ADR 0102) when the Hub has one; otherwise its tonal plate.
        ToneSurface(look: look, image: heroImageForUrl(ref, snap?.heroImageUrl)),
        // The Golden Master's `#view-home.sos-view--hero::before`, as it states it.
        ..._homeScrim(phone),
        LayoutBuilder(
          builder: (context, c) => SingleChildScrollView(
            padding: EdgeInsets.fromLTRB(m.gutter, top, m.gutter, m.bottom + 8),
            child: ConstrainedBox(
              constraints: BoxConstraints(minHeight: c.maxHeight - top - m.bottom - 8),
              child: Column(
                mainAxisAlignment: MainAxisAlignment.end,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (name.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 18),
                      child: Text(name,
                          key: const ValueKey('home-name'),
                          style: text.hero.copyWith(
                              fontSize: nameSize,
                              height: .98,
                              shadows: const [
                                Shadow(color: Color(0x8C000000), blurRadius: 14, offset: Offset(0, 1))
                              ])),
                    ),
                  if (snap?.location != null && !watch)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 16),
                      child: SupremeDayLine(location: snap!.location!, now: ref.watch(residenceNowProvider)),
                    ),
                  if (d != null) ...[
                    Text(settingWhole != null ? 'Setting ${settingWhole.name}…' : d.sentence,
                        key: const ValueKey('home-state'),
                        style: text.sentence.copyWith(
                            fontSize: phone ? 19 : (w * .019).clamp(20.0, 26.0),
                            height: 1.35,
                            color: const Color(0xE6F7F4EE))),
                    Padding(
                      padding: const EdgeInsets.only(top: 14, bottom: 18),
                      child: Wrap(
                        crossAxisAlignment: WrapCrossAlignment.center,
                        spacing: 12,
                        runSpacing: 2,
                        key: const ValueKey('home-signals'),
                        children: [
                          for (var i = 0; i < d.signals.length; i++) ...[
                            if (i > 0)
                              const Text('·', style: TextStyle(color: Color(0x4DF7F4EE))),
                            Text(d.signals[i],
                                style: text.body.copyWith(
                                    fontSize: phone ? 13 : 14,
                                    letterSpacing: .7,
                                    color: SupremeColorScheme.textIdle)),
                          ],
                        ],
                      ),
                    ),
                    if (d.experience != null && settingWhole == null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 22),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Container(
                              width: 6,
                              height: 6,
                              decoration: const BoxDecoration(
                                  shape: BoxShape.circle,
                                  color: SupremeColorScheme.brassLight)),
                          const SizedBox(width: 10),
                          Text('Feels like ${d.experience!.name}',
                              key: const ValueKey('home-feels'),
                              style: text.body.copyWith(
                                  fontSize: 15,
                                  letterSpacing: .3,
                                  color: SupremeColorScheme.brassPale)),
                        ]),
                      ),
                    if (stale)
                      Text('Showing the last known state.',
                          key: const ValueKey('home-stale'),
                          style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.text3))
                    else if (d.note != null)
                      // The way in to what is out: the Devices layer, showing only what is not
                      // responding. (The watch has no inventories — its note stays a sentence.)
                      profile.skeleton == SurfaceSkeleton.watch
                          ? Text(d.note!,
                              key: const ValueKey('home-note'),
                              style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.text3))
                          : SupremeTappable(
                              key: const ValueKey('home-note-open'),
                              onTap: () => openDevices(context, attentionOnly: true),
                              semanticLabel: '${d.note!}. See which devices',
                              radius: 4,
                              child: ConstrainedBox(
                                constraints: const BoxConstraints(minHeight: 44),
                                child: Align(
                                  alignment: Alignment.centerLeft,
                                  child: Text(d.note!,
                                      key: const ValueKey('home-note'),
                                      style: text.body.copyWith(
                                          fontSize: 13,
                                          color: SupremeColorScheme.text3,
                                          decoration: TextDecoration.underline,
                                          decorationColor: const Color(0x55F7F4EE))),
                                ),
                              ),
                            ),
                  ],
                  if (!loaded) _Connection(snap: snap, ref: ref),
                ],
              ),
            ),
          ),
        ),
      ],
    );
  }
}

/// Before the residence has answered: say honestly where things stand, and offer a real retry
/// (§QA-07) — `start()` is the same discover/fall-back/re-authenticate path every reconnect runs.
class _Connection extends StatelessWidget {
  final ResidenceSnapshot? snap;
  final WidgetRef ref;
  const _Connection({required this.snap, required this.ref});

  @override
  Widget build(BuildContext context) {
    final manager = ref.watch(connectionManagerProvider);
    return StreamBuilder<HubConnectionState>(
      stream: manager.state,
      initialData: manager.current,
      builder: (context, s) => ConnectionStateIndicator(
        status: s.data?.status ?? ConnectionStatus.offline,
        onRetry: () {
          manager.start();
          ref.read(residenceStateProvider).refresh();
        },
      ),
    );
  }
}

/// The scrim laid over Home's photograph so the words always read — the Golden Master's own:
/// a phone gets one gradient from the foot (`rgba(8,9,10,.92)` → `.55` at 42% → clear at 72%);
/// everything else gets the foot gradient (`.86` → `.45` at 34% → clear at 62%) and a second from
/// the left (`.5` → clear at 55%).
List<Widget> _homeScrim(bool phone) => phone
    ? const [
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              stops: [0, .42, .72],
              colors: [Color(0xEB08090A), Color(0x8C08090A), Color(0x0008090A)],
            ),
          ),
          child: SizedBox.expand(),
        ),
      ]
    : const [
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.bottomCenter,
              end: Alignment.topCenter,
              stops: [0, .34, .62],
              colors: [Color(0xDB08090A), Color(0x7308090A), Color(0x0008090A)],
            ),
          ),
          child: SizedBox.expand(),
        ),
        DecoratedBox(
          decoration: BoxDecoration(
            gradient: LinearGradient(
              begin: Alignment.centerLeft,
              end: Alignment.centerRight,
              stops: [0, .55],
              colors: [Color(0x8008090A), Color(0x0008090A)],
            ),
          ),
          child: SizedBox.expand(),
        ),
      ];
