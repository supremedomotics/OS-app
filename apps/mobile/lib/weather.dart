import 'dart:convert';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

/// Weather (§ Home Dashboard → Weather) — real local conditions from Open-Meteo, a free keyless
/// forecast service, mirroring the web dashboard. This is a CLIENT-SIDE concern: the app fetches
/// Open-Meteo directly, touching no gateway/backend and inventing no data. Location defaults to a
/// sensible home coordinate; a full location picker can replace it later.
class Weather {
  const Weather({required this.tempC, required this.humidity, required this.code, required this.unit});
  final double tempC;
  final int humidity;
  final int code;
  final String unit;
}

// Default home coordinate — kept in one place so web and mobile agree on the fallback.
const _defaultLat = 19.076;
const _defaultLon = 72.8777;

final weatherProvider = FutureProvider<Weather>((ref) async {
  final url = Uri.parse('https://api.open-meteo.com/v1/forecast'
      '?latitude=$_defaultLat&longitude=$_defaultLon'
      '&current=temperature_2m,relative_humidity_2m,weather_code&timezone=auto');
  final res = await http.get(url);
  if (res.statusCode != 200) throw Exception('weather ${res.statusCode}');
  final j = jsonDecode(res.body) as Map<String, dynamic>;
  final cur = j['current'] as Map<String, dynamic>;
  final units = j['current_units'] as Map<String, dynamic>;
  return Weather(
    tempC: (cur['temperature_2m'] as num).toDouble(),
    humidity: (cur['relative_humidity_2m'] as num).toInt(),
    code: (cur['weather_code'] as num).toInt(),
    unit: units['temperature_2m'] as String? ?? '°C',
  );
});

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

/// A calm weather chip for the dashboard. Renders nothing on error so a failed fetch adds no noise.
class WeatherChip extends ConsumerWidget {
  const WeatherChip({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final w = ref.watch(weatherProvider);
    return w.when(
      loading: () => const SizedBox.shrink(),
      error: (_, __) => const SizedBox.shrink(),
      data: (weather) {
        final d = describeWeather(weather.code);
        final text = Theme.of(context).textTheme;
        return Container(
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
              Text('${d.label} · ${weather.humidity}%', style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
            ]),
          ]),
        );
      },
    );
  }
}
