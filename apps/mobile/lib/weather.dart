import 'dart:convert';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

/// Weather (§ Home Dashboard → Weather) — real local conditions + hourly forecast from Open-Meteo, a
/// free keyless service, with a city picker backed by Open-Meteo's geocoding API. Mirrors the web
/// dashboard. This is a CLIENT-SIDE concern: the app fetches Open-Meteo directly, touching no
/// gateway/backend and inventing no data. Location is an in-memory preference (matching how theme is
/// held) defaulting to a sensible home coordinate.
class GeoLoc {
  const GeoLoc({required this.lat, required this.lon, required this.label});
  final double lat;
  final double lon;
  final String label;
}

/// The active weather location; defaults to a sensible home coordinate, changed by the city picker.
final locationProvider = StateProvider<GeoLoc>((ref) => const GeoLoc(lat: 19.076, lon: 72.8777, label: 'Home'));

class Hour {
  const Hour({required this.time, required this.tempC, required this.code});
  final DateTime time;
  final double tempC;
  final int code;
}

class Weather {
  const Weather({required this.tempC, required this.humidity, required this.code, required this.unit, required this.hourly});
  final double tempC;
  final int humidity;
  final int code;
  final String unit;
  final List<Hour> hourly;
}

class City {
  const City({required this.name, required this.lat, required this.lon, required this.label});
  final String name;
  final double lat;
  final double lon;
  final String label;
}

final weatherProvider = FutureProvider<Weather>((ref) async {
  final loc = ref.watch(locationProvider);
  final url = Uri.parse('https://api.open-meteo.com/v1/forecast'
      '?latitude=${loc.lat}&longitude=${loc.lon}'
      '&current=temperature_2m,relative_humidity_2m,weather_code'
      '&hourly=temperature_2m,weather_code&forecast_days=2&timezone=auto');
  final res = await http.get(url);
  if (res.statusCode != 200) throw Exception('weather ${res.statusCode}');
  final j = jsonDecode(res.body) as Map<String, dynamic>;
  final cur = j['current'] as Map<String, dynamic>;
  final units = j['current_units'] as Map<String, dynamic>;
  final h = j['hourly'] as Map<String, dynamic>;
  final times = (h['time'] as List).cast<String>();
  final temps = (h['temperature_2m'] as List).cast<num>();
  final codes = (h['weather_code'] as List).cast<num>();
  final now = DateTime.now();
  var start = times.indexWhere((t) => DateTime.parse(t).isAfter(now));
  if (start < 0) start = 0;
  final hourly = <Hour>[];
  for (var i = start; i < times.length && hourly.length < 12; i++) {
    hourly.add(Hour(time: DateTime.parse(times[i]), tempC: temps[i].toDouble(), code: codes[i].toInt()));
  }
  return Weather(
    tempC: (cur['temperature_2m'] as num).toDouble(),
    humidity: (cur['relative_humidity_2m'] as num).toInt(),
    code: (cur['weather_code'] as num).toInt(),
    unit: units['temperature_2m'] as String? ?? '°C',
    hourly: hourly,
  );
});

/// City search via Open-Meteo's keyless geocoding API.
Future<List<City>> searchCity(String q) async {
  final url = Uri.parse('https://geocoding-api.open-meteo.com/v1/search'
      '?name=${Uri.encodeQueryComponent(q)}&count=6&language=en&format=json');
  final res = await http.get(url);
  if (res.statusCode != 200) return const [];
  final j = jsonDecode(res.body) as Map<String, dynamic>;
  final results = (j['results'] as List?) ?? const [];
  return results.map((r) {
    final m = r as Map<String, dynamic>;
    final label = [m['name'], m['admin1'], m['country']].where((s) => s != null && (s as String).isNotEmpty).join(', ');
    return City(name: m['name'] as String, lat: (m['latitude'] as num).toDouble(), lon: (m['longitude'] as num).toDouble(), label: label);
  }).toList();
}

/// WMO weather-interpretation code → a homeowner-friendly label + icon.
({String label, IconData icon}) describeWeather(int code) {
  if (code == 0) return (label: 'Clear', icon: Icons.wb_sunny_outlined);
  if (code <= 2) return (label: 'Partly cloudy', icon: Icons.wb_cloudy_outlined);
  if (code == 3) return (label: 'Overcast', icon: Icons.cloud_outlined);
  if (code <= 48) return (label: 'Fog', icon: Icons.foggy);
  if (code <= 57) return (label: 'Drizzle', icon: Icons.grain_outlined);
  if (code <= 67) return (label: 'Rain', icon: Icons.water_drop_outlined);
  if (code <= 77) return (label: 'Snow', icon: Icons.ac_unit_outlined);
  if (code <= 82) return (label: 'Showers', icon: Icons.grain_outlined);
  if (code <= 86) return (label: 'Snow showers', icon: Icons.ac_unit_outlined);
  return (label: 'Thunderstorm', icon: Icons.thunderstorm_outlined);
}

/// A calm weather chip; tap opens a sheet with the hourly forecast + a city picker. Renders nothing
/// on error so a failed fetch adds no noise.
class WeatherChip extends ConsumerWidget {
  const WeatherChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final w = ref.watch(weatherProvider);
    final loc = ref.watch(locationProvider);
    return w.when(
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (weather) {
        final d = describeWeather(weather.code);
        final text = Theme.of(context).textTheme;
        return InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () => showModalBottomSheet<void>(
            context: context, showDragHandle: true, isScrollControlled: true,
            builder: (_) => _WeatherSheet(weather: weather, loc: loc),
          ),
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: Theme.of(context).colorScheme.outlineVariant.withValues(alpha: 0.5)),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(d.icon, size: 26, color: AureonGold.c400),
              const SizedBox(width: 10),
              Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisSize: MainAxisSize.min, children: [
                Text('${weather.tempC.round()}${weather.unit}', style: text.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
                Text('${d.label} · ${loc.label}', style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
              ]),
            ]),
          ),
        );
      },
    );
  }
}

class _WeatherSheet extends ConsumerStatefulWidget {
  const _WeatherSheet({required this.weather, required this.loc});
  final Weather weather;
  final GeoLoc loc;

  @override
  ConsumerState<_WeatherSheet> createState() => _WeatherSheetState();
}

class _WeatherSheetState extends ConsumerState<_WeatherSheet> {
  List<City> _results = const [];
  bool _searching = false;

  Future<void> _search(String q) async {
    if (q.trim().length < 2) { setState(() => _results = const []); return; }
    setState(() => _searching = true);
    final r = await searchCity(q.trim());
    if (mounted) setState(() { _results = r; _searching = false; });
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final scheme = Theme.of(context).colorScheme;
    final w = widget.weather;
    final d = describeWeather(w.code);
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 4, 20, MediaQuery.viewInsetsOf(context).bottom + 20),
      child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(children: [
          Icon(d.icon, size: 40, color: AureonGold.c400),
          const SizedBox(width: 14),
          Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('${w.tempC.round()}${w.unit}', style: text.headlineSmall?.copyWith(fontWeight: FontWeight.w600)),
            Text('${d.label} · ${widget.loc.label}', style: text.labelMedium?.copyWith(color: scheme.onSurfaceVariant)),
          ]),
        ]),
        const SizedBox(height: 14),
        if (w.hourly.isNotEmpty)
          SizedBox(
            height: 92,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: w.hourly.length,
              separatorBuilder: (_, __) => const SizedBox(width: 6),
              itemBuilder: (_, i) {
                final h = w.hourly[i];
                final hd = describeWeather(h.code);
                return Container(
                  width: 56,
                  padding: const EdgeInsets.symmetric(vertical: 10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(12),
                    border: Border.all(color: scheme.outlineVariant.withValues(alpha: 0.4)),
                  ),
                  child: Column(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
                    Text(TimeOfDay.fromDateTime(h.time).format(context).replaceAll(' ', ''), style: text.labelSmall?.copyWith(color: scheme.onSurfaceVariant)),
                    Icon(hd.icon, size: 18, color: AureonGold.c400),
                    Text('${h.tempC.round()}°', style: text.labelMedium?.copyWith(fontWeight: FontWeight.w600)),
                  ]),
                );
              },
            ),
          ),
        const SizedBox(height: 16),
        TextField(
          decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search a city…', border: OutlineInputBorder()),
          onChanged: _search,
        ),
        if (_searching) const Padding(padding: EdgeInsets.only(top: 12), child: Text('Searching…')),
        for (final c in _results)
          ListTile(
            dense: true,
            contentPadding: EdgeInsets.zero,
            leading: const Icon(Icons.place_outlined),
            title: Text(c.label),
            onTap: () {
              ref.read(locationProvider.notifier).state = GeoLoc(lat: c.lat, lon: c.lon, label: c.name);
              Navigator.pop(context);
            },
          ),
      ]),
    );
  }
}
