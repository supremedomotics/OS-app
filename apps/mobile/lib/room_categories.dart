import 'package:flutter/material.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

/// Room navigation (§11.1): Room → control-type category → device list → individual control. A
/// room is never a flat junk-drawer of every device type — you choose WHAT you're here to control
/// first, exactly like a wall keypad is laid out zone by zone. Mirrors the web app's `screens.tsx`
/// categorize()/categorySummary() exactly, so the two platforms group and summarize identically.
enum CategoryKind { lighting, climate, media, curtains, security, fans, cleaning, other }

class CategoryDef {
  const CategoryDef(this.kind, this.label, this.icon);
  final CategoryKind kind;
  final String label;
  final IconData icon;
}

const List<CategoryDef> kCategoryDefs = [
  CategoryDef(CategoryKind.lighting, 'Lighting', Icons.wb_sunny_outlined),
  CategoryDef(CategoryKind.climate, 'Climate', Icons.ac_unit_outlined),
  CategoryDef(CategoryKind.media, 'Media', Icons.music_note_outlined),
  CategoryDef(CategoryKind.curtains, 'Curtains & Blinds', Icons.blinds_outlined),
  CategoryDef(CategoryKind.security, 'Security', Icons.lock_outline),
  CategoryDef(CategoryKind.fans, 'Fans', Icons.mode_fan_off_outlined),
  CategoryDef(CategoryKind.cleaning, 'Cleaning', Icons.cleaning_services_outlined),
  CategoryDef(CategoryKind.other, 'Other', Icons.widgets_outlined),
];

CategoryKind categoryOf(List<String> caps) {
  if (caps.contains('brightness') || caps.contains('color')) return CategoryKind.lighting;
  if (caps.contains('temperature')) return CategoryKind.climate;
  if (caps.contains('media')) return CategoryKind.media;
  if (caps.contains('position')) return CategoryKind.curtains;
  if (caps.contains('lock')) return CategoryKind.security;
  if (caps.contains('fan')) return CategoryKind.fans;
  if (caps.contains('vacuum')) return CategoryKind.cleaning;
  return CategoryKind.other;
}

class Category {
  const Category(this.def, this.devices);
  final CategoryDef def;
  final List<Device> devices;
}

List<Category> categorize(List<Device> devices) {
  final buckets = <CategoryKind, List<Device>>{};
  for (final d in devices) {
    final k = categoryOf(d.capabilities);
    (buckets[k] ??= []).add(d);
  }
  return [for (final def in kCategoryDefs) if (buckets.containsKey(def.kind)) Category(def, buckets[def.kind]!)];
}

/// A short, live "what's happening" line per category — luxury communicates before you read further.
String categorySummary(CategoryKind kind, List<Device> devices, Map<String, Map<String, dynamic>> live) {
  Map<String, dynamic> merged(Device d) => {...d.state, ...?live[d.id]};
  switch (kind) {
    case CategoryKind.lighting:
      final on = devices.where((d) {
        final s = merged(d);
        final b = s['brightness'] as Map<String, dynamic>?;
        final c = s['color'] as Map<String, dynamic>?;
        final o = s['onoff'] as Map<String, dynamic>?;
        return (b?['on'] ?? c?['on'] ?? o?['on']) == true;
      }).length;
      return on > 0 ? '$on of ${devices.length} on' : 'All off';
    case CategoryKind.curtains:
      final open = devices.where((d) => (((merged(d)['position'] as Map<String, dynamic>?)?['position'] as num?) ?? 0) > 0).length;
      return open > 0 ? '$open of ${devices.length} open' : 'All closed';
    case CategoryKind.climate:
      if (devices.length == 1) {
        final t = merged(devices.first)['temperature'] as Map<String, dynamic>?;
        final target = t?['targetC'] as num?;
        if (target != null) return 'Set to ${target.round()}°';
        return '${((t?['ambientC'] as num?) ?? 21).round()}° now';
      }
      return '${devices.length} zones';
    case CategoryKind.media:
      final playing = devices.where((d) => (merged(d)['media'] as Map<String, dynamic>?)?['playback'] == 'playing').length;
      return playing > 0 ? '$playing playing' : 'Idle';
    case CategoryKind.security:
      final locked = devices.where((d) => (merged(d)['lock'] as Map<String, dynamic>?)?['locked'] != false).length;
      return locked == devices.length ? 'All locked' : '${devices.length - locked} unlocked';
    case CategoryKind.fans:
      final on = devices.where((d) => (merged(d)['fan'] as Map<String, dynamic>?)?['on'] == true).length;
      return on > 0 ? '$on on' : 'All off';
    case CategoryKind.cleaning:
      final active = devices.where((d) => (merged(d)['vacuum'] as Map<String, dynamic>?)?['status'] == 'cleaning').length;
      return active > 0 ? 'Cleaning' : 'Idle';
    case CategoryKind.other:
      final on = devices.where((d) => (merged(d)['onoff'] as Map<String, dynamic>?)?['on'] == true).length;
      return on > 0 ? '$on on' : 'All off';
  }
}
