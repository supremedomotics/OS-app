import 'package:supreme_sdk/supreme_sdk.dart';

/// Room hero imagery (mobile/tablet parity with the web app, §11). A room's photo is, in order:
///   1. its stored `heroImageUrl` — once the hub has downloaded & SAVED the photo locally it's
///      served from the hub, so the image is identical on every page and every app and works
///      offline. Resolved (with the access token) via [SupremeClient.heroImageSrc].
///   2. a keyword stock photo (by room name/areaType) shown as a fallback WHILE the hub pins a
///      local copy (see [ensureRoomHero]) — the same subject the hub stores, so the swap is seamless.
///
/// The keyword logic mirrors services/gateway/src/room-hero.ts and apps/web-homeowner/src/
/// room-image.ts so a given room resolves to the same subject everywhere.

const Map<String, String> _areaKeywords = {
  'living': 'living room',
  'bedroom': 'bedroom',
  'kitchen': 'kitchen',
  'bathroom': 'bathroom',
  'office': 'office',
  'outdoor': 'garden',
  'utility': 'laundry room',
  'hallway': 'hallway',
  'other': 'modern interior',
};

const List<List<String>> _nameKeywords = [
  [r'conference|meeting|board\s?room', 'conference room'],
  [r'garage', 'garage interior'],
  [r'gym|fitness|workout', 'home gym'],
  [r'terrace|balcony', 'terrace'],
  [r'garden|yard|patio|outdoor', 'garden'],
  [r'dining', 'dining room'],
  [r'theat(er|re)|cinema|media', 'home theater'],
  [r'pool', 'swimming pool'],
  [r'kid|child|nursery', 'kids room'],
  [r'study|library|reading', 'home library'],
  [r'lobby|reception|foyer|entrance', 'hotel lobby'],
  [r'showroom', 'showroom interior'],
  [r'master\s?bed', 'luxury bedroom'],
  [r'living|lounge|family', 'living room'],
  [r'kitchen|pantry', 'kitchen'],
];

int _lockFor(String s) {
  var h = 2166136261;
  for (var i = 0; i < s.length; i++) {
    h ^= s.codeUnitAt(i);
    h = (h * 16777619) & 0xffffffff;
  }
  return h.abs() % 100000;
}

String _keywordFor(String name, String? areaType) {
  for (final entry in _nameKeywords) {
    if (RegExp(entry[0], caseSensitive: false).hasMatch(name)) return entry[1];
  }
  return _areaKeywords[areaType ?? 'other'] ?? _areaKeywords['other']!;
}

String _stockPhoto(String name, String? areaType) {
  final keyword = _keywordFor(name, areaType);
  final lock = _lockFor(name + (areaType ?? ''));
  return 'https://loremflickr.com/1200/800/${Uri.encodeComponent(keyword)}?lock=$lock';
}

/// The hero/card image URL for a room. Hub-stored photo when present (identical everywhere),
/// else a deterministic stock fallback by name.
String roomImageUrl(SupremeClient client, String name, String? areaType, String? heroImageUrl) {
  final resolved = client.heroImageSrc(heroImageUrl);
  if (resolved != null) return resolved;
  return _stockPhoto(name, areaType);
}

// Rooms we've already asked the hub to pin, so we don't re-POST on every rebuild.
final Set<String> _pinRequested = {};

/// Fire-and-forget: the first time a room without a stored hero is shown, ask the hub to download
/// and save a stock photo locally. Returns true if a photo is now stored (caller can refresh).
/// Never throws — imagery is best-effort.
Future<bool> ensureRoomHero(SupremeClient client, String roomId, String? heroImageUrl) async {
  if ((heroImageUrl != null && heroImageUrl.isNotEmpty) || _pinRequested.contains(roomId)) {
    return false;
  }
  _pinRequested.add(roomId);
  try {
    return await client.pinRoomHeroImage(roomId);
  } catch (_) {
    _pinRequested.remove(roomId);
    return false;
  }
}
