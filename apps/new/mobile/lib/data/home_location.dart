import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:supreme_os_core/supreme_os_core.dart';

/// A place on Earth, as the residence is told where it is (the original's "Location" field:
/// "City, country"). The Hub keeps it (`PUT/POST /v1/home/location`), and the sun — its line on
/// Home and Spaces, "at sunset" schedules — is computed from it.
class Place {
  final String label;
  final double lat;
  final double lon;
  final String? timeZone;
  const Place(
      {required this.label,
      required this.lat,
      required this.lon,
      this.timeZone});

  Map<String, Object?> toJson() =>
      {'lat': lat, 'lon': lon, 'timeZone': timeZone, 'label': label};
}

/// Thrown when the place search itself could not be reached (as opposed to "no such place").
class PlaceLookupUnavailable implements Exception {
  const PlaceLookupUnavailable();
}

typedef PlaceLookup = Future<Place?> Function(String query);

/// Resolves "City, country" to coordinates and an IANA time zone with Open-Meteo's public
/// geocoding (the same service the web app's weather picker uses). Null when nothing matches;
/// [PlaceLookupUnavailable] when the search could not be reached.
Future<Place?> openMeteoLookup(String query, {http.Client? client}) async {
  final c = client ?? http.Client();
  try {
    // "Palma, Spain" → search the city, and prefer the result whose country/region matches the rest.
    final parts = query.split(',').map((e) => e.trim()).where((e) => e.isNotEmpty).toList();
    if (parts.isEmpty) return null;
    final uri = Uri.https('geocoding-api.open-meteo.com', '/v1/search',
        {'name': parts.first, 'count': '10', 'language': 'en', 'format': 'json'});
    final res = await c.get(uri).timeout(const Duration(seconds: 8));
    if (res.statusCode != 200) throw const PlaceLookupUnavailable();
    final results = ((jsonDecode(res.body) as Map)['results'] as List?)?.cast<Map>() ?? const [];
    if (results.isEmpty) return null;
    final rest = parts.skip(1).map((e) => e.toLowerCase()).toList();
    bool matches(Map r) {
      final hay = '${r['country'] ?? ''} ${r['admin1'] ?? ''} ${r['country_code'] ?? ''}'.toLowerCase();
      return rest.every((w) => hay.contains(w));
    }
    final best = results.firstWhere(matches, orElse: () => results.first);
    final name = best['name'] as String;
    final country = best['country'] as String?;
    return Place(
      label: country == null ? name : '$name, $country',
      lat: (best['latitude'] as num).toDouble(),
      lon: (best['longitude'] as num).toDouble(),
      timeZone: best['timezone'] as String?,
    );
  } on PlaceLookupUnavailable {
    rethrow;
  } on TimeoutException {
    throw const PlaceLookupUnavailable();
  } catch (e) {
    if (e is PlaceLookupUnavailable) rethrow;
    throw const PlaceLookupUnavailable();
  } finally {
    if (client == null) c.close();
  }
}

/// Tells the paired Hub where the residence is. The Hub is the one place it lives: every phone,
/// panel and schedule reads it from there.
Future<void> writeHubLocation({
  required Uri hubBase,
  required String Function() bearerToken,
  required Place place,
}) async {
  final t = HttpHubTransport(baseUrl: hubBase, bearerToken: bearerToken);
  await t.authenticate();
  await t.sendCommand('v1/home/location', place.toJson().cast<String, dynamic>());
}
