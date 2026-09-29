/// Hub-served pictures for a space or the residence (ADR 0102): authenticated bytes, cached by URL.
///
/// The Hub versions every picture's URL by content hash (`…/hero-image?v=<hash>`), so a URL's bytes
/// never change: a cached entry is valid forever and a replaced photograph is simply a new URL. A
/// failed fetch is remembered briefly (so a screen that rebuilds does not hammer an unreachable
/// Hub) and is never turned into a stand-in picture: the caller shows its honest tonal plate.
///
/// Only Hub-relative paths (`/v1/...`) are fetched here; anything else is not the Hub's to serve.
library;

import 'dart:async';
import 'dart:typed_data';

import '../connection/transport.dart';

typedef HubBytesFetch = Future<HubBytes> Function(String path, {String? ifNoneMatch});

class HeroImageStore {
  final HubBytesFetch _fetch;
  final DateTime Function() _now;
  final Duration retryAfter;

  final _bytes = <String, Uint8List>{};
  final _inFlight = <String, Future<Uint8List?>>{};
  final _failedAt = <String, DateTime>{};
  final _loaded = StreamController<String>.broadcast();

  HeroImageStore({
    required HubBytesFetch fetch,
    DateTime Function()? now,
    this.retryAfter = const Duration(seconds: 60),
  })  : _fetch = fetch,
        _now = now ?? DateTime.now;

  /// The path of each picture as it arrives.
  Stream<String> get loaded => _loaded.stream;

  static bool isHubPath(String? p) => p != null && p.startsWith('/v1/');

  Uint8List? cached(String path) => _bytes[path];

  /// The picture, or null when it cannot be had right now (not a Hub path, unreachable, refused).
  Future<Uint8List?> load(String path) {
    if (!isHubPath(path)) return Future.value(null);
    final hit = _bytes[path];
    if (hit != null) return Future.value(hit);
    final failed = _failedAt[path];
    if (failed != null && _now().difference(failed) < retryAfter) return Future.value(null);
    // A block body: `remove` returns this very future, and whenComplete would wait on it forever.
    return _inFlight[path] ??= _get(path).whenComplete(() {
      _inFlight.remove(path);
    });
  }

  Future<Uint8List?> _get(String path) async {
    try {
      final res = await _fetch(path);
      final b = res.bytes;
      if (b == null || b.isEmpty) {
        _failedAt[path] = _now();
        return null;
      }
      _failedAt.remove(path);
      final bytes = Uint8List.fromList(b);
      _bytes[path] = bytes;
      if (!_loaded.isClosed) _loaded.add(path);
      return bytes;
    } catch (_) {
      _failedAt[path] = _now();
      return null;
    }
  }

  Future<void> dispose() => _loaded.close();
}
