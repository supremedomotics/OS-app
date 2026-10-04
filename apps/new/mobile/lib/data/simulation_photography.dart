import 'package:flutter/services.dart' show AssetBundle;
import 'package:supreme_os_core/supreme_os_core.dart';

/// The Golden Master's room photography, for the simulated residence only.
///
/// A real Hub serves a space's picture on its own route (`/v1/rooms/:id/hero-image`, ADR 0102) and
/// Flutter fetches it there; the simulator speaks that same route, so the photographs reach the
/// screens by the production path — nothing here draws a picture. The files are the original's
/// `window.SUPREMEOS_ASSETS`, extracted unchanged by `tools/golden-master-verify`.
///
/// The original's mapping of space → photograph, expressed in the simulator's room ids:
///   Living Room → Living · Dining Room → Dining · Kitchen → Kitchen · Powder Room → Bathroom ·
///   Master Bedroom → Master Bedroom · Terrace → Outdoor · Entrance → Residential,
/// and the residence's own picture is Residential. (The simulated villa has no Powder Room or
/// Entrance; their entries are kept so the mapping reads whole.)
const simulationPhotographFiles = <String?, String>{
  null: 'residential', // the residence
  'living': 'living',
  'dining': 'dining',
  'kitchen': 'kitchen',
  'powder': 'bathroom',
  'master': 'master-bedroom',
  'terrace': 'outdoor',
  'entrance': 'residential',
};

/// room id (null = the residence) → the photograph's bytes.
typedef SimulationPhotographs = Map<String?, List<int>>;

Future<SimulationPhotographs> loadSimulationPhotography(AssetBundle bundle) async {
  final byFile = <String, List<int>>{};
  final out = <String?, List<int>>{};
  for (final e in simulationPhotographFiles.entries) {
    final data = byFile[e.value] ??=
        (await bundle.load('assets/golden_master/photography/${e.value}.jpg'))
            .buffer
            .asUint8List();
    out[e.key] = data;
  }
  return out;
}

/// Gives each simulated space (that exists) its photograph, as the Hub's asset slot does.
void applySimulationPhotography(SimulatedResidence sim, SimulationPhotographs photos) {
  for (final e in photos.entries) {
    try {
      sim.setHeroImage(e.key, e.value);
    } on StateError {
      // A room this villa does not have (Powder Room, Entrance).
    }
  }
}
