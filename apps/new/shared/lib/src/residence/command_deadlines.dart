/// How long a command may take before the residence calls it unanswered — per capability, because
/// a light answers in a moment and a curtain takes a minute (§ command lifecycle).
///
/// The SAME table the Hub's scene runner uses (`DEFAULT_DEADLINES` in
/// `services/gateway/src/scene-runs.ts`), pinned by `command_deadlines_test.dart`, so a single
/// command and an Experience step are judged by one clock: a shade the Hub is still waiting for is
/// never already "not responding" on the panel. A device that keeps reporting movement restarts its
/// own deadline (the device is visibly answering), which is how a slow but genuine 90-second
/// traverse is not failed by the deadline.
library;

const defaultCommandDeadlines = <String, Duration>{
  'onoff': Duration(seconds: 10),
  'brightness': Duration(seconds: 10),
  'media': Duration(seconds: 10),
  'temperature': Duration(seconds: 15),
  'position': Duration(seconds: 90),
};

/// A capability the table does not name (a driver-specific one that is still verifiable).
const fallbackCommandDeadline = Duration(seconds: 10);

Duration commandDeadlineFor(String capability,
        {Map<String, Duration> overrides = const {}}) =>
    overrides[capability] ??
    defaultCommandDeadlines[capability] ??
    fallbackCommandDeadline;
