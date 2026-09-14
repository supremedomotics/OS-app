import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';

/// Entering a room, not opening a device dashboard (§18). Uses the real shared domain
/// controls (§Phase7-13) and [AdaptivePanel] to compose them — the same components the Touch
/// Panel reference layouts use.
///
/// §Phase12.3: state is now genuinely live — read from and written through the active Home's
/// [HomeStateRepository] (`homeStateRepositoryProvider`), never hardcoded. Each domain
/// independently shows a loading state until its first real read completes, and NEVER shows a
/// value for a domain the Hub hasn't actually reported (§ "never a fabricated default").
class RoomScreen extends ConsumerWidget {
  final Space space;
  final VoidCallback onBack;
  const RoomScreen({super.key, required this.space, required this.onBack});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final repo = ref.watch(homeStateRepositoryProvider);
    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          RoomHeader(roomName: space.name, onBack: onBack),
          Expanded(
            child: AdaptivePanel(
              children: [
                if (space.domains.contains(HomeDomain.lighting))
                  _LiveLighting(repo: repo, spaceId: space.id),
                if (space.domains.contains(HomeDomain.shades))
                  _LiveShades(repo: repo, spaceId: space.id),
                if (space.domains.contains(HomeDomain.climate))
                  _LiveClimate(repo: repo, spaceId: space.id),
                if (space.domains.contains(HomeDomain.audio))
                  _LiveAudio(repo: repo, spaceId: space.id),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _LiveLighting extends StatefulWidget {
  final HomeStateRepository repo;
  final String spaceId;
  const _LiveLighting({required this.repo, required this.spaceId});
  @override
  State<_LiveLighting> createState() => _LiveLightingState();
}

class _LiveLightingState extends State<_LiveLighting> {
  late Future<DomainState<LightingValue>?> _future =
      widget.repo.lighting(widget.spaceId);
  ConfirmationState _pending = ConfirmationState.confirmed;

  Future<void> _apply(Future<void> Function() send) async {
    setState(() => _pending = ConfirmationState.requested);
    try {
      await send();
      setState(() {
        _pending = ConfirmationState.confirmed;
        _future = widget.repo.lighting(widget.spaceId);
      });
    } catch (_) {
      setState(() => _pending = ConfirmationState.failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<DomainState<LightingValue>?>(
      future: _future,
      builder: (context, snap) {
        if (_isAmbiguous(snap)) {
          return const _NotConfiguredCard(label: 'Lighting');
        }
        if (!snap.hasData || snap.data == null) {
          return const _LoadingDomainCard(label: 'Lighting');
        }
        final value = snap.data!.value;
        return LightingControl(
          on: value.on,
          mood: value.mood,
          confirmation: _pending == ConfirmationState.confirmed
              ? snap.data!.confirmation
              : _pending,
          onToggle: (on) =>
              _apply(() => widget.repo.setLighting(widget.spaceId, on: on)),
          onMoodChanged: (mood) =>
              _apply(() => widget.repo.setLighting(widget.spaceId, mood: mood)),
        );
      },
    );
  }
}

class _LiveShades extends StatefulWidget {
  final HomeStateRepository repo;
  final String spaceId;
  const _LiveShades({required this.repo, required this.spaceId});
  @override
  State<_LiveShades> createState() => _LiveShadesState();
}

class _LiveShadesState extends State<_LiveShades> {
  late Future<DomainState<ShadesValue>?> _future =
      widget.repo.shades(widget.spaceId);
  ConfirmationState _pending = ConfirmationState.confirmed;

  static const _presetPercent = {
    ShadePosition.open: 100,
    ShadePosition.relaxed: 60,
    ShadePosition.closed: 0,
  };

  Future<void> _applyPreset(ShadePosition position) =>
      _apply(_presetPercent[position] ?? 60);

  Future<void> _apply(int percent) async {
    setState(() => _pending = ConfirmationState.requested);
    try {
      await widget.repo.setShadesPosition(widget.spaceId, percentOpen: percent);
      setState(() {
        _pending = ConfirmationState.confirmed;
        _future = widget.repo.shades(widget.spaceId);
      });
    } catch (_) {
      setState(() => _pending = ConfirmationState.failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<DomainState<ShadesValue>?>(
      future: _future,
      builder: (context, snap) {
        if (!snap.hasData || snap.data == null) {
          if (_isAmbiguous(snap)) {
            return const _NotConfiguredCard(label: 'Shades');
          }
          return const _LoadingDomainCard(label: 'Shades');
        }
        final value = snap.data!.value;
        return ShadesControl(
          position: value.position,
          positionPercent: value.percentOpen.toDouble(),
          confirmation: _pending == ConfirmationState.confirmed
              ? snap.data!.confirmation
              : _pending,
          onPositionChanged: _applyPreset,
        );
      },
    );
  }
}

class _LiveClimate extends StatefulWidget {
  final HomeStateRepository repo;
  final String spaceId;
  const _LiveClimate({required this.repo, required this.spaceId});
  @override
  State<_LiveClimate> createState() => _LiveClimateState();
}

class _LiveClimateState extends State<_LiveClimate> {
  late Future<DomainState<ClimateValue>?> _future =
      widget.repo.climate(widget.spaceId);
  ConfirmationState _pending = ConfirmationState.confirmed;

  Future<void> _apply(Future<void> Function() send) async {
    setState(() => _pending = ConfirmationState.requested);
    try {
      await send();
      setState(() {
        _pending = ConfirmationState.confirmed;
        _future = widget.repo.climate(widget.spaceId);
      });
    } catch (_) {
      setState(() => _pending = ConfirmationState.failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<DomainState<ClimateValue>?>(
      future: _future,
      builder: (context, snap) {
        if (!snap.hasData || snap.data == null) {
          if (_isAmbiguous(snap)) {
            return const _NotConfiguredCard(label: 'Climate');
          }
          return const _LoadingDomainCard(label: 'Climate');
        }
        final value = snap.data!.value;
        return ClimateControl(
          ambientC: value.ambientC,
          targetC: value.targetC,
          mode: value.mode,
          confirmation: _pending == ConfirmationState.confirmed
              ? snap.data!.confirmation
              : _pending,
          onIncrease: () => _apply(() => widget.repo
              .setClimate(widget.spaceId, targetC: value.targetC + 0.5)),
          onDecrease: () => _apply(() => widget.repo
              .setClimate(widget.spaceId, targetC: value.targetC - 0.5)),
          onModeChanged: (mode) =>
              _apply(() => widget.repo.setClimate(widget.spaceId, mode: mode)),
        );
      },
    );
  }
}

class _LiveAudio extends StatefulWidget {
  final HomeStateRepository repo;
  final String spaceId;
  const _LiveAudio({required this.repo, required this.spaceId});
  @override
  State<_LiveAudio> createState() => _LiveAudioState();
}

class _LiveAudioState extends State<_LiveAudio> {
  late Future<DomainState<AudioValue>?> _future =
      widget.repo.audio(widget.spaceId);
  ConfirmationState _pending = ConfirmationState.confirmed;

  Future<void> _apply(Future<void> Function() send) async {
    setState(() => _pending = ConfirmationState.requested);
    try {
      await send();
      setState(() {
        _pending = ConfirmationState.confirmed;
        _future = widget.repo.audio(widget.spaceId);
      });
    } catch (_) {
      setState(() => _pending = ConfirmationState.failed);
    }
  }

  @override
  Widget build(BuildContext context) {
    return FutureBuilder<DomainState<AudioValue>?>(
      future: _future,
      builder: (context, snap) {
        if (!snap.hasData || snap.data == null) {
          if (_isAmbiguous(snap)) {
            return const _NotConfiguredCard(label: 'Audio');
          }
          return const _LoadingDomainCard(label: 'Audio');
        }
        final value = snap.data!.value;
        return AudioControl(
          playing: value.playing,
          title: value.title,
          artist: value.artist,
          volumePercent: value.volumePercent.toDouble(),
          confirmation: _pending == ConfirmationState.confirmed
              ? snap.data!.confirmation
              : _pending,
          onPlayPause: () => _apply(() =>
              widget.repo.setAudio(widget.spaceId, playing: !value.playing)),
        );
      },
    );
  }
}

/// §Phase12.10 §14 — true only when the repository threw `AmbiguousDeviceResolutionException`
/// (§Phase12.9's "refuse to guess" behavior for a room with 2+ devices sharing a capability).
/// Never inspects the message text or exposes it — the homeowner never sees a device id,
/// exception name, protocol name, or driver identifier; that detail stays in
/// `AmbiguousDeviceResolutionException.toString()` for Professional Mode/logs only, not built
/// here (§14: "do not build an elaborate Professional Mode workflow in this phase").
bool _isAmbiguous<T>(AsyncSnapshot<T> snap) =>
    snap.hasError && snap.error is AmbiguousDeviceResolutionException;

/// The safe, product-level state for a room whose Hub-side semantic mapping is ambiguous
/// (§Phase12.10 §14) — homeowner-relevant language only, never a technical exception.
class _NotConfiguredCard extends StatelessWidget {
  final String label;
  const _NotConfiguredCard({required this.label});
  @override
  Widget build(BuildContext context) {
    return SupremeCard(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            const Icon(Icons.info_outline, size: 20),
            const SizedBox(width: 12),
            Expanded(
              child: Text("$label isn't fully configured yet."),
            ),
          ],
        ),
      ),
    );
  }
}

/// Shown while a domain's first real read is in flight, or when the Hub simply hasn't
/// reported a value yet — never a fabricated on/off/percent standing in for real data.
class _LoadingDomainCard extends StatelessWidget {
  final String label;
  const _LoadingDomainCard({required this.label});
  @override
  Widget build(BuildContext context) {
    return SupremeCard(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Row(
          children: [
            const SizedBox(
                width: 16,
                height: 16,
                child: CircularProgressIndicator(strokeWidth: 2)),
            const SizedBox(width: 12),
            Text('$label — connecting…'),
          ],
        ),
      ),
    );
  }
}
