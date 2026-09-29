import 'package:supreme_os_core/supreme_os_core.dart';

/// The whole client stack against the simulated Hub, driven by a manual clock.
class Rig {
  final clock = ManualScheduler();
  late final SimulatedResidence sim;
  late final ResidenceState state;
  late final CommandTracker tracker;
  late final ExperienceActivations activations;

  /// Every route the client sent, in order.
  final sent = <String>[];

  Rig({Duration commandTimeout = const Duration(seconds: 8)}) {
    sim = SimulatedResidence(schedule: clock.schedule, now: clock.now);
    state = ResidenceState(get: sim.transport.get, frames: sim.stream.frames, now: clock.now);
    Future<Map<String, dynamic>> post(String path, Map<String, dynamic> body) async {
      sent.add(path);
      return sim.transport.sendCommand(path, body);
    }

    tracker = CommandTracker(
      send: (id, c) => post('v1/devices/$id/command', {'command': c}),
      state: state,
      timeout: commandTimeout,
      schedule: clock.schedule,
      now: clock.now,
    );
    activations = ExperienceActivations(post: post, state: state, now: clock.now);
  }

  Future<void> start() async {
    await sim.transport.authenticate();
    await state.start();
  }

  Future<void> advance(int ms) => clock.advance(Duration(milliseconds: ms));
  ResidenceSnapshot get snap => state.snapshot;
  Experience exp(String id) => snap.experiences.firstWhere((e) => e.id == id);
  ExperienceStatus status(String id, {String? spaceId}) => experienceStatus(exp(id), snap,
      commands: tracker.inFlight, activations: activations.inFlight, spaceId: spaceId);
  Map<String, dynamic>? cap(String id, String c) => snap.devices[id]?.state[c];
}
