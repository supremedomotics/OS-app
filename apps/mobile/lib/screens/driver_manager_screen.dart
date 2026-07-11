import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Extension Center (§ Extension Center) — mobile parity with the web app. The central place for
/// every integration and protocol driver, populated from the driver REGISTRY so any current or
/// future extension appears automatically. Browsable by category; each card expands to a
/// schema-generated config page plus install / enable / connect / health / logs controls.
const _deviceCategories = ['lighting', 'climate', 'shades', 'media', 'security', 'energy'];
const _cats = <(String, String)>[
  ('all', 'All'), ('official', 'Official'), ('community', 'Community'), ('protocol', 'Protocol'),
  ('device', 'Device'), ('ai', 'AI'), ('experimental', 'Experimental'),
];

bool _matches(Map<String, dynamic> d, String cat) {
  final protocols = ((d['protocols'] as List?) ?? const []);
  final channel = d['channel'] as String?;
  final category = d['category'] as String?;
  switch (cat) {
    case 'all': return true;
    case 'official': return channel == 'official' || channel == 'certified';
    case 'community': return channel == 'community';
    case 'protocol': return category == 'protocol' || protocols.isNotEmpty;
    case 'device': return _deviceCategories.contains(category);
    case 'ai': return RegExp('ai|intelligence|assistant', caseSensitive: false).hasMatch('${d['name']} ${d['description']} $category');
    case 'experimental': return channel == 'beta' || d['shipsDisabled'] == true;
    default: return true;
  }
}

class ExtensionCenterScreen extends ConsumerStatefulWidget {
  const ExtensionCenterScreen({super.key});

  @override
  ConsumerState<ExtensionCenterScreen> createState() => _ExtensionCenterScreenState();
}

class _ExtensionCenterScreenState extends ConsumerState<ExtensionCenterScreen> {
  String _cat = 'all';

  @override
  Widget build(BuildContext context) {
    final registry = ref.watch(driverRegistryProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Extension Center')),
      body: registry.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load extensions\n$e', textAlign: TextAlign.center)),
        data: (drivers) {
          final shown = drivers.where((d) => _matches(d, _cat)).toList();
          return RefreshIndicator(
            onRefresh: () async => ref.invalidate(driverRegistryProvider),
            child: ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                SizedBox(
                  height: 40,
                  child: ListView(
                    scrollDirection: Axis.horizontal,
                    children: [
                      for (final (id, label) in _cats)
                        if (id == 'all' || drivers.any((d) => _matches(d, id)))
                          Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: ChoiceChip(
                              label: Text('$label ${drivers.where((d) => _matches(d, id)).length}'),
                              selected: _cat == id,
                              onSelected: (_) => setState(() => _cat = id),
                            ),
                          ),
                    ],
                  ),
                ),
                const SizedBox(height: AureonSpacing.sm),
                for (final d in shown) _DriverTile(driver: d),
              ],
            ),
          );
        },
      ),
    );
  }
}

/// A prominent certification badge derived from the driver's registry `channel` — mobile parity with
/// the web Extension Center — so homeowners can tell at a glance whether an extension is vetted by
/// Supreme, community-made, or experimental. Presentation of existing registry data only.
({String label, IconData icon, Color color}) _cert(String? channel, BuildContext context) {
  switch (channel) {
    case 'official':
    case 'certified':
      return (label: 'Official', icon: Icons.verified, color: AureonGold.c400);
    case 'community':
      return (label: 'Community', icon: Icons.people_outline, color: Theme.of(context).colorScheme.onSurfaceVariant);
    case 'beta':
      return (label: 'Experimental', icon: Icons.science_outlined, color: AureonStatus.warning);
    default:
      return (label: channel ?? 'Unknown', icon: Icons.extension_outlined, color: Theme.of(context).colorScheme.onSurfaceVariant);
  }
}

({String text, Color color}) _status(Map<String, dynamic> d, BuildContext context) {
  if (d['installed'] != true) return (text: 'Not installed', color: Theme.of(context).disabledColor);
  if (d['enabled'] != true) return (text: 'Disabled', color: Theme.of(context).disabledColor);
  if (d['status'] == 'error') return (text: 'Error', color: AureonStatus.critical);
  return (text: 'Active', color: AureonStatus.good);
}

class _DriverTile extends StatelessWidget {
  const _DriverTile({required this.driver});
  final Map<String, dynamic> driver;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final s = _status(driver, context);
    final requiresSku = driver['requiresSku'] as String?;
    final cert = _cert(driver['channel'] as String?, context);
    return Card(
      child: ExpansionTile(
        title: Row(children: [
          Flexible(child: Text(driver['name'] as String? ?? driver['key'] as String? ?? 'Driver', overflow: TextOverflow.ellipsis)),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: cert.color.withValues(alpha: 0.55)),
            ),
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(cert.icon, size: 12, color: cert.color),
              const SizedBox(width: 4),
              Text(cert.label, style: text.labelSmall?.copyWith(color: cert.color, fontWeight: FontWeight.w600)),
            ]),
          ),
        ]),
        subtitle: Text('${driver['category'] ?? ''} · v${driver['version'] ?? ''}${requiresSku != null ? ' · $requiresSku' : ''}', style: text.labelSmall),
        trailing: Text(s.text, style: text.labelMedium?.copyWith(color: s.color, fontWeight: FontWeight.w600)),
        childrenPadding: const EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, AureonSpacing.md),
        children: [_DriverDetail(driver: driver)],
      ),
    );
  }
}

class _DriverDetail extends ConsumerStatefulWidget {
  const _DriverDetail({required this.driver});
  final Map<String, dynamic> driver;

  @override
  ConsumerState<_DriverDetail> createState() => _DriverDetailState();
}

class _DriverDetailState extends ConsumerState<_DriverDetail> {
  late Map<String, dynamic> _values = Map<String, dynamic>.from(widget.driver['config'] as Map? ?? {});
  Map<String, dynamic>? _health;
  bool _busy = false;

  Map<String, dynamic> get d => widget.driver;
  String? get _id => d['installedId'] as String?;
  bool get _installed => d['installed'] == true;
  List<Map<String, dynamic>> get _schema => ((d['configSchema'] as List?) ?? const []).cast<Map<String, dynamic>>();
  List<String> get _ops => ((d['operations'] as List?) ?? const []).cast<String>();
  bool get _isProtocol => ((d['protocols'] as List?) ?? const []).isNotEmpty;

  @override
  void initState() {
    super.initState();
    if (_installed && _id != null) {
      _load();
    }
  }

  Future<void> _load() async {
    final id = _id;
    if (id == null) return;
    try {
      final cfg = await ref.read(clientProvider).driverConfig(id);
      final health = await ref.read(clientProvider).driverHealth(id);
      if (!mounted) return;
      setState(() {
        _values = Map<String, dynamic>.from((cfg['config'] as Map?) ?? {});
        _health = health;
      });
    } catch (_) {/* leave defaults */}
  }

  Future<void> _run(Future<void> Function() action, String ok) async {
    final messenger = ScaffoldMessenger.of(context);
    setState(() => _busy = true);
    try {
      await action();
      ref.invalidate(driverRegistryProvider);
      messenger.showSnackBar(SnackBar(content: Text(ok)));
    } catch (e) {
      messenger.showSnackBar(SnackBar(content: Text('Failed: $e')));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final client = ref.read(clientProvider);
    final id = _id;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if ((d['description'] as String?)?.isNotEmpty ?? false)
          Padding(padding: const EdgeInsets.only(bottom: AureonSpacing.sm), child: Text(d['description'] as String, style: text.labelMedium)),

        // About — the extension's real metadata (§ Extension Center rich fields). Only registry-backed
        // fields are shown; nothing is fabricated.
        _about(context, [
          ('Developer', d['publisher'] as String?),
          ('Version', d['version'] != null
              ? 'v${d['version']}${_installed && d['installedVersion'] != null && d['installedVersion'] != d['version'] ? ' (installed v${d['installedVersion']})' : ''}'
              : null),
          ('Channel', d['channel'] as String?),
          ('Category', d['category'] as String?),
          ('Compatibility', d['hubMinVersion'] != null ? 'Supreme OS ≥ v${d['hubMinVersion']}' : null),
          ('Requires license', d['requiresSku'] as String?),
          ('Protocols', _joinList(d['protocols'])),
          ('Capabilities', _joinList(d['capabilities'])),
          ('Dependencies', _joinList(d['dependencies'])),
          ('Documentation', d['documentationUrl'] as String?),
        ]),

        // Release notes + changelog (§ Extension Center) — shown only when authored.
        if ((d['releaseNotes'] as String?)?.isNotEmpty ?? false) ...[
          Padding(padding: const EdgeInsets.only(bottom: 4), child: Text('Release notes', style: text.titleSmall)),
          Padding(padding: const EdgeInsets.only(bottom: AureonSpacing.sm), child: Text(d['releaseNotes'] as String, style: text.labelMedium)),
        ],
        if (((d['changelog'] as List?) ?? const []).isNotEmpty)
          ExpansionTile(
            tilePadding: EdgeInsets.zero,
            title: Text('Changelog (${((d['changelog'] as List?) ?? const []).length})', style: text.labelLarge),
            children: [
              for (final c in ((d['changelog'] as List?) ?? const []).cast<Map<String, dynamic>>())
                ListTile(
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  title: Text('v${c['version']} · ${c['date']}', style: text.labelSmall),
                  subtitle: Text(c['notes'] as String? ?? ''),
                ),
            ],
          ),

        // Lifecycle actions.
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (!_installed && _ops.contains('install'))
            FilledButton(onPressed: _busy ? null : () => _run(() => client.installDriver(d['key'] as String), 'Installed'), child: const Text('Install')),
          if (_installed && id != null) ...[
            if (d['updateAvailable'] == true)
              FilledButton(onPressed: _busy ? null : () => _run(() => client.updateDriver(d['key'] as String), 'Updated'), child: Text('Update to v${d['version']}')),
            if (_ops.contains('enable'))
              OutlinedButton(onPressed: _busy ? null : () => _run(() => client.setDriverEnabled(id, d['enabled'] != true), d['enabled'] == true ? 'Disabled' : 'Enabled'), child: Text(d['enabled'] == true ? 'Disable' : 'Enable')),
            if (_isProtocol && _ops.contains('connect'))
              OutlinedButton(onPressed: _busy ? null : () => _run(() => client.connectDriver(id, true), 'Connect requested'), child: const Text('Connect')),
            if (_isProtocol && _ops.contains('disconnect'))
              OutlinedButton(onPressed: _busy ? null : () => _run(() => client.connectDriver(id, false), 'Disconnect requested'), child: const Text('Disconnect')),
            if (_ops.contains('uninstall'))
              OutlinedButton(
                style: OutlinedButton.styleFrom(foregroundColor: AureonStatus.critical),
                onPressed: _busy ? null : () => _run(() => client.uninstallDriver(id), 'Uninstalled'),
                child: const Text('Uninstall'),
              ),
          ],
        ]),

        // Schema-generated config page.
        if (_installed && _schema.isNotEmpty) ...[
          const SizedBox(height: AureonSpacing.md),
          Text('Configuration', style: text.titleSmall),
          for (final f in _schema) _field(f),
          const SizedBox(height: AureonSpacing.sm),
          FilledButton(
            onPressed: _busy || id == null ? null : () => _run(() => client.setDriverConfig(id, _values), 'Configuration saved').then((_) => _load()),
            child: const Text('Save configuration'),
          ),
        ],

        // KNX ETS group-address import — the answer to "where do I add my group addresses"
        // once the bus is connected. Protocol-specific (KNX only), so it's a direct addition
        // here rather than a generic schema field.
        if (_installed && ((d['protocols'] as List?)?.contains('knx') ?? false)) const _KnxImportPanel(),

        // Health.
        if (_health != null) ...[
          const SizedBox(height: AureonSpacing.sm),
          Text(
            'Health: ${_health!['verdict']}'
            '${_health!['configComplete'] == false ? ' · needs configuration' : ''}'
            '${_health!['connected'] == true ? ' · connected' : ''}',
            style: text.labelMedium?.copyWith(color: _health!['verdict'] == 'healthy' ? AureonStatus.good : _health!['verdict'] == 'error' ? AureonStatus.critical : null),
          ),
        ],
      ],
    );
  }

  static String? _joinList(dynamic v) {
    final list = ((v as List?) ?? const []).cast<Object?>().map((e) => e.toString()).where((s) => s.isNotEmpty).toList();
    return list.isEmpty ? null : list.join(', ');
  }

  /// A compact label/value list of the extension's real metadata; rows with no value are dropped.
  Widget _about(BuildContext context, List<(String, String?)> rows) {
    final text = Theme.of(context).textTheme;
    final present = rows.where((r) => r.$2 != null && r.$2!.isNotEmpty).toList();
    if (present.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(bottom: AureonSpacing.sm),
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (final (label, value) in present)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 2),
            child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
              SizedBox(width: 108, child: Text(label, style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant))),
              Expanded(child: Text(value!, style: text.labelMedium)),
            ]),
          ),
      ]),
    );
  }

  Widget _field(Map<String, dynamic> f) {
    final key = f['key'] as String;
    final label = f['label'] as String? ?? key;
    final type = f['type'] as String? ?? 'text';
    final required = f['required'] == true;
    final current = _values[key];

    if (type == 'boolean') {
      return SwitchListTile(
        contentPadding: EdgeInsets.zero,
        title: Text(label),
        value: current == true,
        onChanged: (v) => setState(() => _values[key] = v),
      );
    }
    if (type == 'select') {
      final options = ((f['options'] as List?) ?? const []).cast<Map<String, dynamic>>();
      return Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: DropdownButtonFormField<String>(
          initialValue: current?.toString(),
          decoration: InputDecoration(labelText: label + (required ? ' *' : '')),
          items: [for (final o in options) DropdownMenuItem(value: o['value'] as String, child: Text(o['label'] as String))],
          onChanged: (v) => setState(() => _values[key] = v),
        ),
      );
    }
    final isNumber = type == 'number' || type == 'port';
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: TextFormField(
        initialValue: current == null ? '' : current.toString(),
        obscureText: type == 'password',
        keyboardType: isNumber ? TextInputType.number : TextInputType.text,
        decoration: InputDecoration(labelText: label + (required ? ' *' : ''), helperText: f['help'] as String?, hintText: f['placeholder'] as String?),
        onChanged: (v) => setState(() => _values[key] = isNumber ? (num.tryParse(v) ?? v) : v),
      ),
    );
  }
}

/// Human-facing labels for the circuit type `classifyCircuit()` infers from a device's
/// bindings — matches KNX_CIRCUIT_LABELS in the web installer (apps/web-installer/src/pages.tsx).
/// Human-facing labels for the fine-grained device taxonomy the KNX Import Engine
/// classifies against — mirrors KNX_DEVICE_TYPE_LABELS in the web installer
/// (apps/web-installer/src/api.ts). Falls back to the raw key for any type not listed.
const _kKnxDeviceTypeLabels = {
  'light_switch': 'Light — On/Off', 'light_dimmable': 'Light — Dimmable',
  'light_tunable_white': 'Light — Tunable White', 'light_rgb': 'Light — RGB',
  'light_rgbw': 'Light — RGBW', 'light_rgbww': 'Light — RGBWW', 'light_color_temp': 'Light — Colour Temp',
  'curtain': 'Curtain', 'blind': 'Blind', 'roller_shutter': 'Roller Shutter', 'garage_door': 'Garage Door',
  'thermostat': 'Thermostat', 'hvac_vrf': 'HVAC — VRF', 'hvac_split_ac': 'HVAC — Split AC',
  'hvac_cassette_ac': 'HVAC — Cassette AC', 'hvac_duct_ac': 'HVAC — Duct AC', 'fan_coil': 'Fan Coil', 'fan': 'Fan',
  'sensor_temperature': 'Sensor — Temperature', 'sensor_humidity': 'Sensor — Humidity',
  'sensor_motion': 'Sensor — Motion', 'sensor_presence': 'Sensor — Presence', 'sensor_lux': 'Sensor — Illuminance',
  'sensor_pressure': 'Sensor — Pressure', 'sensor_co2': 'Sensor — CO₂', 'sensor_pm25': 'Sensor — PM2.5',
  'sensor_leak': 'Sensor — Leak', 'sensor_smoke': 'Sensor — Smoke', 'sensor_door': 'Sensor — Door',
  'sensor_window': 'Sensor — Window', 'energy_meter': 'Energy Meter', 'scene': 'Scene', 'audio': 'Audio',
  'gate': 'Gate', 'door_lock': 'Door Lock', 'irrigation': 'Irrigation', 'pool': 'Pool',
  'ventilation': 'Ventilation', 'custom_device': 'Custom Device',
};

/// KNX ETS group-address import (§4): paste an ETS group-address export (CSV/XML/`.esf` —
/// capabilities and device type inferred from each datapoint type, the ETS Main/Middle
/// Group, and the address name) to preview the auto-discovered device cards, review
/// room/name/type, include/exclude devices, then save. Binary `.knxproj` upload needs a
/// native file picker not yet wired into the mobile app — paste covers the common export
/// path; the web app has both.
class _KnxImportPanel extends ConsumerStatefulWidget {
  const _KnxImportPanel();

  @override
  ConsumerState<_KnxImportPanel> createState() => _KnxImportPanelState();
}

class _KnxImportPanelState extends ConsumerState<_KnxImportPanel> {
  final _controller = TextEditingController();
  bool _busy = false;
  String? _result;
  String? _err;
  // Parsed-but-unsaved devices the installer reviews before committing. Each map is the
  // server's preview entry plus a local `included` toggle; nothing is saved until Commit.
  List<Map<String, dynamic>>? _preview;
  List<Map<String, dynamic>> _warnings = const [];

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _doPreview() async {
    final content = _controller.text.trim();
    if (content.isEmpty) return;
    setState(() { _busy = true; _err = null; _result = null; });
    try {
      final out = await ref.read(clientProvider).previewKnx(content);
      final devices = ((out['devices'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final warnings = ((out['warnings'] as List?) ?? const []).cast<Map<String, dynamic>>();
      final stats = (out['stats'] as Map?)?.cast<String, dynamic>() ?? const {};
      setState(() {
        _preview = devices.map((d) => {...d, 'included': true}).toList();
        _warnings = warnings;
        _result = 'Parsed ${stats['groupAddressCount'] ?? '?'} group address(es) into '
            '${devices.length} device${devices.length == 1 ? '' : 's'} — review below, then save.';
      });
    } catch (e) {
      setState(() => _err = 'Preview failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _commit() async {
    final preview = _preview;
    if (preview == null) return;
    setState(() { _busy = true; _err = null; _result = null; });
    try {
      final out = await ref.read(clientProvider).commitKnxImport(preview);
      final devices = (out['devices'] as num?)?.toInt() ?? 0;
      final rooms = (out['roomsCreated'] as num?)?.toInt() ?? 0;
      setState(() {
        _result = 'Saved $devices device${devices == 1 ? '' : 's'}'
            '${rooms > 0 ? ' · $rooms new room${rooms == 1 ? '' : 's'}' : ''}.';
        _preview = null;
        _warnings = const [];
        _controller.clear();
      });
      ref.invalidate(homeProvider);
    } catch (e) {
      setState(() => _err = 'Save failed: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final preview = _preview;
    return Padding(
      padding: const EdgeInsets.only(top: AureonSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text('Import ETS project', style: text.titleSmall),
          const SizedBox(height: 4),
          if (preview == null) ...[
            Text(
              'Paste an ETS group-address export (CSV/XML/.esf). Capabilities and device type '
              'are inferred from each datapoint type — review before saving.',
              style: text.labelMedium,
            ),
            const SizedBox(height: AureonSpacing.sm),
            TextField(
              controller: _controller,
              maxLines: 5,
              style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
              decoration: const InputDecoration(
                border: OutlineInputBorder(),
                hintText: '<GroupAddress Name="Living Room - Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />',
              ),
            ),
            const SizedBox(height: AureonSpacing.sm),
            FilledButton(
              onPressed: _busy ? null : _doPreview,
              child: Text(_busy ? 'Parsing…' : 'Preview group addresses'),
            ),
          ] else ...[
            if (_warnings.isNotEmpty) _warningsPanel(context),
            for (var i = 0; i < preview.length; i++) _previewRow(context, i, preview[i]),
            const SizedBox(height: AureonSpacing.sm),
            Row(children: [
              FilledButton(
                onPressed: _busy || !preview.any((d) => d['included'] == true) ? null : _commit,
                child: Text(_busy ? 'Saving…' : 'Save & Commission (${preview.where((d) => d['included'] == true).length})'),
              ),
              const SizedBox(width: AureonSpacing.sm),
              TextButton(
                onPressed: _busy ? null : () => setState(() { _preview = null; _warnings = const []; _result = null; }),
                child: const Text('Cancel'),
              ),
            ]),
          ],
          if (_result != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_result!, style: text.labelMedium)),
          if (_err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(_err!, style: TextStyle(color: AureonStatus.critical))),
        ],
      ),
    );
  }

  Widget _warningsPanel(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(bottom: AureonSpacing.sm),
      color: AureonStatus.warning.withValues(alpha: 0.08),
      child: Padding(
        padding: const EdgeInsets.all(AureonSpacing.sm),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('${_warnings.length} warning${_warnings.length == 1 ? '' : 's'}', style: text.labelLarge?.copyWith(fontWeight: FontWeight.w600)),
          Text('Non-fatal — every device below still imports; these addresses need a closer look or manual binding afterward.', style: text.labelSmall),
          const SizedBox(height: 4),
          for (final w in _warnings)
            Text('• ${w['message'] as String? ?? ''}', style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
        ]),
      ),
    );
  }

  Widget _previewRow(BuildContext context, int i, Map<String, dynamic> d) {
    final text = Theme.of(context).textTheme;
    final included = d['included'] == true;
    final bindings = ((d['bindings'] as List?) ?? const []).cast<Map<String, dynamic>>();
    final deviceType = d['deviceType'] as String? ?? 'custom_device';
    final confidence = (d['confidence'] as num?)?.toDouble() ?? 1.0;
    return Opacity(
      opacity: included ? 1 : 0.45,
      child: Card(
        margin: const EdgeInsets.symmetric(vertical: 4),
        child: Padding(
          padding: const EdgeInsets.all(AureonSpacing.sm),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Checkbox(
              value: included,
              onChanged: (v) => setState(() => d['included'] = v ?? false),
            ),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Row(children: [
                  Expanded(
                    child: TextFormField(
                      enabled: included,
                      initialValue: d['name'] as String? ?? '',
                      style: text.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
                      decoration: const InputDecoration(isDense: true, border: InputBorder.none),
                      onChanged: (v) => d['name'] = v,
                    ),
                  ),
                  Chip(label: Text(_kKnxDeviceTypeLabels[deviceType] ?? deviceType), visualDensity: VisualDensity.compact),
                ]),
                if (confidence < 1)
                  Text('guessed from name — no ETS device data', style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant)),
                const SizedBox(height: 4),
                TextFormField(
                  enabled: included,
                  initialValue: d['room'] as String? ?? '',
                  decoration: const InputDecoration(labelText: 'Room', isDense: true, border: OutlineInputBorder()),
                  onChanged: (v) => d['room'] = v.isEmpty ? null : v,
                ),
                const SizedBox(height: 4),
                Text(
                  bindings.map((b) {
                    final status = b['statusAddress'] as String?;
                    return '${b['capability']}: ${b['address']}${status != null ? ' (feedback $status)' : ''}';
                  }).join(', '),
                  style: text.labelSmall?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                ),
              ]),
            ),
          ]),
        ),
      ),
    );
  }
}
