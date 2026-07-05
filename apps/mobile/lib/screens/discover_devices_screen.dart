import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// Discover Devices (§ Automatic Device Discovery) — mobile parity with the web page. One tap scans
/// every supported technology at once; the protocol list + the recommended extension come from the
/// driver REGISTRY (never hardcoded). Pairing auto-installs the required extension, then assigns a
/// room + name in one guided step.
class DiscoverDevicesScreen extends ConsumerStatefulWidget {
  const DiscoverDevicesScreen({super.key});

  @override
  ConsumerState<DiscoverDevicesScreen> createState() => _DiscoverDevicesScreenState();
}

class _DiscoverDevicesScreenState extends ConsumerState<DiscoverDevicesScreen> {
  bool _scanning = false;
  bool _scanned = false;
  List<Map<String, dynamic>> _found = [];
  String? _error;

  Future<void> _scan() async {
    setState(() { _scanning = true; _error = null; });
    try {
      final found = await ref.read(clientProvider).discover();
      if (!mounted) return;
      setState(() { _found = found; _scanned = true; });
    } catch (e) {
      if (mounted) setState(() => _error = 'Scan failed: $e');
    } finally {
      if (mounted) setState(() => _scanning = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final registry = ref.watch(driverRegistryProvider).valueOrNull ?? const [];
    final protocols = <String>{for (final d in registry) ...((d['protocols'] as List?) ?? const []).cast<String>()}.toList()..sort();
    final active = <String>{for (final d in registry) if (d['installed'] == true && d['enabled'] == true) ...((d['protocols'] as List?) ?? const []).cast<String>()};

    return Scaffold(
      appBar: AppBar(title: const Text('Discover Devices')),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.md),
        children: [
          Text('One tap scans every supported technology and pairs what it finds — no manual setup.',
              style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: AureonSpacing.md),
          if (protocols.isNotEmpty)
            Wrap(spacing: 6, runSpacing: 6, children: [
              for (final p in protocols)
                Chip(
                  label: Text(p.toUpperCase(), style: const TextStyle(fontSize: 11)),
                  visualDensity: VisualDensity.compact,
                  backgroundColor: active.contains(p) ? AureonStatus.good.withValues(alpha: 0.14) : null,
                ),
            ]),
          const SizedBox(height: AureonSpacing.lg),
          if (!_scanned)
            Center(
              child: Column(children: [
                Icon(Icons.radar, size: 88, color: Theme.of(context).colorScheme.primary.withValues(alpha: 0.6)),
                const SizedBox(height: AureonSpacing.lg),
                FilledButton(
                  onPressed: _scanning ? null : _scan,
                  child: Text(_scanning ? 'Scanning all technologies…' : 'Discover Devices'),
                ),
              ]),
            ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: AureonStatus.critical))),
          if (_scanned) ...[
            Row(mainAxisAlignment: MainAxisAlignment.spaceBetween, children: [
              Text('${_found.length} device${_found.length == 1 ? '' : 's'} found', style: Theme.of(context).textTheme.labelMedium),
              TextButton(onPressed: _scanning ? null : _scan, child: const Text('Rescan')),
            ]),
            if (_found.isEmpty)
              Padding(padding: const EdgeInsets.all(12), child: Text('No new devices found. Ensure devices are powered and on the network, then rescan.', style: Theme.of(context).textTheme.labelMedium)),
            for (final d in _found)
              _FoundDevice(
                device: d,
                driver: _recommend(registry, d['protocol'] as String?),
                onPaired: () => setState(() => _found = _found.where((x) => x['backendId'] != d['backendId']).toList()),
              ),
          ],
        ],
      ),
    );
  }

  Map<String, dynamic>? _recommend(List<Map<String, dynamic>> registry, String? protocol) {
    if (protocol == null) return null;
    for (final d in registry) {
      if (((d['protocols'] as List?) ?? const []).contains(protocol)) return d;
    }
    return null;
  }
}

class _FoundDevice extends ConsumerStatefulWidget {
  const _FoundDevice({required this.device, required this.driver, required this.onPaired});
  final Map<String, dynamic> device;
  final Map<String, dynamic>? driver;
  final VoidCallback onPaired;

  @override
  ConsumerState<_FoundDevice> createState() => _FoundDeviceState();
}

class _FoundDeviceState extends ConsumerState<_FoundDevice> {
  late final TextEditingController _name = TextEditingController(text: widget.device['suggestedName'] as String? ?? 'Device');
  String? _roomId;
  bool _busy = false;
  String? _step;
  String? _err;

  @override
  void dispose() { _name.dispose(); super.dispose(); }

  Future<void> _pair(List<Map<String, dynamic>> rooms) async {
    if (_roomId == null) { setState(() => _err = 'Pick a room.'); return; }
    setState(() { _busy = true; _err = null; });
    final client = ref.read(clientProvider);
    try {
      final driver = widget.driver;
      if (driver != null && driver['installed'] != true) {
        setState(() => _step = 'Installing ${driver['name']}…');
        await client.installDriver(driver['key'] as String);
      }
      setState(() => _step = 'Pairing device…');
      await client.commission(
        backendId: widget.device['backendId'] as String,
        name: _name.text.trim().isEmpty ? (widget.device['suggestedName'] as String? ?? 'Device') : _name.text.trim(),
        roomId: _roomId!,
        capabilities: ((widget.device['capabilities'] as List?) ?? const []).cast<String>(),
        protocol: widget.device['protocol'] as String?,
      );
      ref.invalidate(homeProvider);
      widget.onPaired();
    } catch (e) {
      setState(() { _err = 'Pairing failed: $e'; _step = null; });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final home = ref.watch(homeProvider).valueOrNull;
    final rooms = home?.rooms.map((r) => {'id': r.id, 'name': r.name}).toList() ?? [];
    _roomId ??= rooms.isNotEmpty ? rooms.first['id'] as String : null;
    final d = widget.device;
    final caps = ((d['capabilities'] as List?) ?? const []).cast<String>();
    return Card(
      child: ExpansionTile(
        leading: Icon(Icons.sensors, color: Theme.of(context).colorScheme.primary),
        title: Text(d['suggestedName'] as String? ?? 'Device'),
        subtitle: Text('${(d['protocol'] as String?)?.toUpperCase() ?? d['source']} · ${caps.join(', ')}', style: Theme.of(context).textTheme.labelSmall),
        childrenPadding: const EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, AureonSpacing.md),
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(widget.driver != null
              ? 'Extension: ${widget.driver!['name']}${widget.driver!['installed'] == true ? '' : ' (auto-install)'}'
              : 'No matching extension', style: Theme.of(context).textTheme.labelMedium),
          const SizedBox(height: 8),
          TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name')),
          const SizedBox(height: 8),
          DropdownButtonFormField<String>(
            initialValue: _roomId,
            decoration: const InputDecoration(labelText: 'Room'),
            items: [for (final r in rooms) DropdownMenuItem(value: r['id'] as String, child: Text(r['name'] as String))],
            onChanged: (v) => setState(() => _roomId = v),
          ),
          const SizedBox(height: 8),
          Row(children: [
            FilledButton(onPressed: _busy || rooms.isEmpty ? null : () => _pair(rooms), child: Text(_busy ? (_step ?? 'Pairing…') : 'Pair device')),
            const SizedBox(width: 8),
            TextButton(onPressed: _busy ? null : widget.onPaired, child: const Text('Ignore')),
          ]),
          if (_step != null && _err == null) Text(_step!, style: Theme.of(context).textTheme.labelSmall),
          if (_err != null) Text(_err!, style: const TextStyle(color: AureonStatus.critical)),
        ],
      ),
    );
  }
}
