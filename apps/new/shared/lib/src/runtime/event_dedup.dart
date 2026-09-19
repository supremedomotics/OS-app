import 'home_event.dart';

/// §Phase12.5 §13 — prevents the same doorphone ring/notification/state event from being
/// processed twice after a retry/reconnect. Keyed on `(hubId, eventId)`
/// ([HomeEvent.dedupKey]), never `eventId` alone — two Homes must never collide even if a bug
/// ever produced the same raw id from two different Hubs (§3/§10 isolation).
///
/// Deliberately does NOT invent a server-side sequence number — the Hub's own `eventId` is
/// trusted as-is (§13: "do not invent server sequence numbers if the Hub doesn't provide
/// them"); this class only remembers which ids it has already seen, bounded by [capacity] so
/// a long-running background isolate doesn't grow this set forever.
class SeenEventTracker {
  final int capacity;
  final List<String> _order = [];
  final Set<String> _seen = {};

  SeenEventTracker({this.capacity = 500});

  /// Returns true the FIRST time this event is seen (caller should process it), false on every
  /// subsequent call for the same `(hubId, eventId)` (caller must skip it).
  bool markIfNew(HomeEvent event) {
    final key = event.dedupKey;
    if (_seen.contains(key)) return false;
    _seen.add(key);
    _order.add(key);
    if (_order.length > capacity) {
      final evicted = _order.removeAt(0);
      _seen.remove(evicted);
    }
    return true;
  }

  bool hasSeen(HomeEvent event) => _seen.contains(event.dedupKey);
}
