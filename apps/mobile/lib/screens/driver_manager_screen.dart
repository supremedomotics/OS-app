import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Driver Manager (§9) — mobile parity with the web app. Populates from the driver REGISTRY, so any
/// current or future driver appears automatically; each expands to a schema-generated config page
/// plus install / enable / connect / health / logs controls.
class DriverManagerScreen extends ConsumerWidget {
  const DriverManagerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final registry = ref.watch(driverRegistryProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Drivers & integrations')),
      body: registry.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Could not load drivers\n$e', textAlign: TextAlign.center)),
        data: (drivers) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(driverRegistryProvider),
          child: ListView(
            padding: const EdgeInsets.all(AureonSpacing.md),
            children: [for (final d in drivers) _DriverTile(driver: d)],
          ),
        ),
      ),
    );
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
    return Card(
      child: ExpansionTile(
        title: Text(driver['name'] as String? ?? driver['key'] as String? ?? 'Driver'),
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

        // Lifecycle actions.
        Wrap(spacing: 8, runSpacing: 8, children: [
          if (!_installed && _ops.contains('install'))
            FilledButton(onPressed: _busy ? null : () => _run(() => client.installDriver(d['key'] as String), 'Installed'), child: const Text('Install')),
          if (_installed && id != null) ...[
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
