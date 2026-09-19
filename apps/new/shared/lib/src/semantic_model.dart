import 'capabilities.dart';

/// A physical space a homeowner walks into. This is the only unit Mobile and
/// Touch Panel navigate by — never a raw device list (§18).
class Space {
  final String id;
  final String name;
  final String? floorId;
  final String? imageUrl;
  final Set<HomeDomain> domains;

  const Space({
    required this.id,
    required this.name,
    this.floorId,
    this.imageUrl,
    this.domains = const {},
  });
}

class Floor {
  final String id;
  final String name;
  final List<String> spaceIds;
  const Floor({required this.id, required this.name, required this.spaceIds});
}

/// requested vs confirmed state (§31) — the UI must never claim success purely
/// because a command was sent.
enum ConfirmationState { requested, confirmed, failed }

class DomainState<T> {
  final T value;
  final ConfirmationState confirmation;
  const DomainState(this.value, this.confirmation);
}

/// Lighting is represented as environmental language, not raw Kelvin (§19).
enum LightingMood { candle, warm, neutral, cool, custom }

enum ShadePosition { open, relaxed, closed, custom }

enum ClimateMode { auto, cooling, heating, off }

/// §Phase12.3 — the concrete per-domain values a room's live state is made of. Deliberately
/// SupremeOS-semantic (mood, position, setpoint), never protocol-shaped (no DPT, cluster,
/// group address, or datapoint appears anywhere in this file) — the homeowner UI, and
/// everything downstream of [HomeStateRepository], only ever sees these.
class LightingValue {
  final bool on;
  final LightingMood mood;
  const LightingValue({required this.on, required this.mood});
}

class ShadesValue {
  final ShadePosition position;
  final int percentOpen;
  const ShadesValue({required this.position, required this.percentOpen});
}

class ClimateValue {
  final double ambientC;
  final double targetC;
  final ClimateMode mode;
  const ClimateValue(
      {required this.ambientC, required this.targetC, required this.mode});
}

class AudioValue {
  final bool playing;
  final String? title;
  final String? artist;
  final int volumePercent;
  const AudioValue(
      {required this.playing,
      this.title,
      this.artist,
      required this.volumePercent});
}
