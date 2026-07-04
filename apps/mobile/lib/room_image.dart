import 'package:flutter/material.dart' show Color;
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

String _keywordFor(String name, String? areaType) {
  for (final entry in _nameKeywords) {
    if (RegExp(entry[0], caseSensitive: false).hasMatch(name)) return entry[1];
  }
  return _areaKeywords[areaType ?? 'other'] ?? _areaKeywords['other']!;
}

/// A designed, room-type background (deep two-tone + a motif emoji) shown when a room has no photo —
/// so a card is never flat colour. Mirrors the web `roomGradient`.
class RoomStyle {
  const RoomStyle(this.from, this.to, this.emoji);
  final Color from;
  final Color to;
  final String emoji;
}

const Map<String, RoomStyle> _roomStyles = {
  'living room': RoomStyle(Color(0xFF3A2A1C), Color(0xFF12100E), '🛋'),
  'kitchen': RoomStyle(Color(0xFF3A3320), Color(0xFF121110), '🍽'),
  'bedroom': RoomStyle(Color(0xFF2C2338), Color(0xFF100F14), '🛏'),
  'luxury bedroom': RoomStyle(Color(0xFF332740), Color(0xFF110F16), '🛏'),
  'bathroom': RoomStyle(Color(0xFF1E3336), Color(0xFF0E1314), '🛁'),
  'office': RoomStyle(Color(0xFF22303A), Color(0xFF0E1114), '💼'),
  'home library': RoomStyle(Color(0xFF2E2318), Color(0xFF12100C), '📚'),
  'dining room': RoomStyle(Color(0xFF3A2226), Color(0xFF130F10), '🍷'),
  'home theater': RoomStyle(Color(0xFF241F3A), Color(0xFF0D0C14), '🎬'),
  'home gym': RoomStyle(Color(0xFF1F3336), Color(0xFF0D1213), '🏋'),
  'swimming pool': RoomStyle(Color(0xFF153842), Color(0xFF0B1417), '🏊'),
  'garden': RoomStyle(Color(0xFF1F3324), Color(0xFF0D130E), '🌿'),
  'terrace': RoomStyle(Color(0xFF33301F), Color(0xFF12110C), '🌆'),
  'garage interior': RoomStyle(Color(0xFF2A2E33), Color(0xFF101113), '🚗'),
  'kids room': RoomStyle(Color(0xFF333A20), Color(0xFF12130C), '🧸'),
  'hotel lobby': RoomStyle(Color(0xFF332A1C), Color(0xFF12100C), '🛎'),
  'conference room': RoomStyle(Color(0xFF25303A), Color(0xFF0E1013), '📊'),
  'showroom interior': RoomStyle(Color(0xFF2F2A33), Color(0xFF100F12), '✨'),
  'laundry room': RoomStyle(Color(0xFF243033), Color(0xFF0F1213), '🧺'),
  'hallway': RoomStyle(Color(0xFF2C2A26), Color(0xFF100F0E), '🚪'),
  'modern interior': RoomStyle(Color(0xFF2A2A30), Color(0xFF0F0F12), '🏠'),
};

RoomStyle roomStyle(String name, String? areaType) =>
    _roomStyles[_keywordFor(name, areaType)] ?? _roomStyles['modern interior']!;

/// The hero/card PHOTO url for a room, or null when there's no stored photo (the caller then paints
/// the [roomStyle] gradient). We no longer point at an external stock CDN directly — an unreachable
/// URL rendered as flat colour; the hub fetches & stores the photo (see [ensureRoomHero]).
String? roomImageUrl(SupremeClient client, String name, String? areaType, String? heroImageUrl) {
  return client.heroImageSrc(heroImageUrl);
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
