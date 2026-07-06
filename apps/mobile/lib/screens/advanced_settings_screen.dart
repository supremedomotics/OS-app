import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../errors.dart';
import '../providers.dart';

/// Advanced settings (§10/§16) — mobile parity with the web app. The "pro" hub functions that were
/// previously API-only are now point-and-click: circadian lighting, the climate schedule, adaptive
/// ventilation, the energy tariff, the electricity provider/rate, and peak load-shifting. Each panel
/// loads its current state and saves back through the Supreme SDK.
class AdvancedSettingsScreen extends ConsumerStatefulWidget {
  const AdvancedSettingsScreen({super.key});

  @override
  ConsumerState<AdvancedSettingsScreen> createState() => _AdvancedSettingsScreenState();
}

class _AdvancedSettingsScreenState extends ConsumerState<AdvancedSettingsScreen> {
  SupremeClient get _c => ref.read(clientProvider);

  List<Device> _devices = [];
  Map<String, dynamic>? _circadian;
  Map<String, dynamic> _climate = {'weekday': [], 'weekend': []};
  Map<String, dynamic>? _vent;
  bool _fanOn = false;
  Map<String, dynamic>? _tariff;
  Map<String, dynamic>? _provider;
  List<String> _deferrable = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final results = await Future.wait([
        _c.devices(),
        _c.circadianTarget().catchError((_) => <String, dynamic>{}),
        _c.climateProgram().catchError((_) => null),
        _c.ventilation().catchError((_) => <String, dynamic>{}),
        _c.tariff().catchError((_) => null),
        _c.energyProvider().catchError((_) => null),
        _c.deferrableLoads().catchError((_) => <String, dynamic>{}),
      ]);
      if (!mounted) return;
      setState(() {
        _devices = results[0] as List<Device>;
        _circadian = results[1] as Map<String, dynamic>?;
        _climate = (results[2] as Map<String, dynamic>?) ??
            {
              'weekday': [
                {'atMinutes': 360, 'targetC': 21},
                {'atMinutes': 1320, 'targetC': 18},
              ],
              'weekend': [
                {'atMinutes': 480, 'targetC': 21},
                {'atMinutes': 1380, 'targetC': 18},
              ],
            };
        final v = results[3] as Map<String, dynamic>;
        _vent = v['config'] as Map<String, dynamic>?;
        _fanOn = v['fanOn'] == true;
        _tariff = (results[4] as Map<String, dynamic>?) ??
            {
              'currency': 'USD',
              'standingChargePerDay': 0,
              'periods': [
                {'name': 'peak', 'ratePerKwh': 0.40, 'hours': [16, 17, 18, 19, 20]},
                {'name': 'off-peak', 'ratePerKwh': 0.15, 'hours': [for (var h = 0; h < 24; h++) if (h < 16 || h > 20) h]},
              ],
            };
        _provider = results[5] as Map<String, dynamic>?;
        final dl = results[6] as Map<String, dynamic>;
        _deferrable = ((dl['deviceIds'] as List?) ?? const []).cast<String>();
        _loading = false;
      });
    } catch (_) {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _toast(String msg) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
  Future<void> _run(Future<void> Function() action, String ok) async {
    try { await action(); _toast(ok); } catch (e) { _toast(friendlyError(e)); }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Advanced')),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView(
              padding: const EdgeInsets.all(AureonSpacing.md),
              children: [
                Text('Automation & energy tuning. Optional — sensible defaults apply until you set these.',
                    style: Theme.of(context).textTheme.labelMedium),
                const SizedBox(height: AureonSpacing.sm),
                _circadianPanel(),
                _climatePanel(),
                _ventilationPanel(),
                _tariffPanel(),
                _providerPanel(),
                _loadShiftPanel(),
              ],
            ),
    );
  }

  Widget _panel(String title, String? subtitle, List<Widget> children) => Card(
        child: ExpansionTile(
          title: Text(title),
          subtitle: subtitle == null ? null : Text(subtitle, style: Theme.of(context).textTheme.labelSmall),
          childrenPadding: const EdgeInsets.fromLTRB(AureonSpacing.md, 0, AureonSpacing.md, AureonSpacing.md),
          expandedCrossAxisAlignment: CrossAxisAlignment.start,
          children: children,
        ),
      );

  // ── Circadian ────────────────────────────────────────────────────────────────
  Widget _circadianPanel() {
    final t = _circadian?['target'] as Map<String, dynamic>?;
    return _panel('Circadian lighting', 'Human-centric white', [
      Text(
        t == null
            ? 'Natural white target for the time of day.'
            : 'Right now the natural target is ${t['kelvin']}K at ${(t['brightness'] as num).round()}% brightness.',
        style: Theme.of(context).textTheme.labelMedium,
      ),
      const SizedBox(height: AureonSpacing.sm),
      FilledButton(
        onPressed: () => _run(() async {
          final applied = await _c.applyCircadian();
          _toast('Applied to ${applied.length} light${applied.length == 1 ? '' : 's'}.');
        }, 'Applied'),
        child: const Text('Apply circadian now'),
      ),
    ]);
  }

  // ── Climate schedule ─────────────────────────────────────────────────────────
  Widget _climatePanel() {
    List<Map<String, dynamic>> blocks(String k) => ((_climate[k] as List?) ?? const []).cast<Map<String, dynamic>>();
    Widget editor(String k) {
      final list = blocks(k);
      return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        for (var i = 0; i < list.length; i++)
          Row(children: [
            TextButton(
              onPressed: () async {
                final m = list[i]['atMinutes'] as int;
                final picked = await showTimePicker(context: context, initialTime: TimeOfDay(hour: m ~/ 60, minute: m % 60));
                if (picked != null) setState(() => list[i]['atMinutes'] = picked.hour * 60 + picked.minute);
              },
              child: Text(_fmt(list[i]['atMinutes'] as int)),
            ),
            Expanded(
              child: Slider(
                min: 5, max: 35, divisions: 60,
                value: (list[i]['targetC'] as num).toDouble(),
                label: '${(list[i]['targetC'] as num).toStringAsFixed(1)}°C',
                onChanged: (v) => setState(() => list[i]['targetC'] = double.parse(v.toStringAsFixed(1))),
              ),
            ),
            Text('${(list[i]['targetC'] as num).toStringAsFixed(0)}°'),
            IconButton(icon: const Icon(Icons.close, size: 18), onPressed: () => setState(() => list.removeAt(i))),
          ]),
        TextButton.icon(
          onPressed: () => setState(() => list.add({'atMinutes': 720, 'targetC': 20})),
          icon: const Icon(Icons.add, size: 18), label: const Text('Add block'),
        ),
      ]);
    }

    return _panel('Climate schedule', 'Programmable thermostat', [
      Text('Weekday', style: Theme.of(context).textTheme.titleSmall),
      editor('weekday'),
      const SizedBox(height: 8),
      Text('Weekend', style: Theme.of(context).textTheme.titleSmall),
      editor('weekend'),
      const SizedBox(height: 8),
      FilledButton(onPressed: () => _run(() => _c.setClimateProgram(_climate), 'Climate schedule saved'), child: const Text('Save schedule')),
    ]);
  }

  // ── Ventilation ──────────────────────────────────────────────────────────────
  Widget _ventilationPanel() {
    final sensors = _devices.where((d) => d.capabilities.contains('sensor')).toList();
    final fans = _devices.where((d) => d.capabilities.contains('fan') || d.capabilities.contains('onoff')).toList();
    final cfg = _vent ??= {};
    return _panel('Adaptive ventilation', _fanOn ? 'Fan running' : 'Air-quality fan', [
      const Text('Run a fan automatically when an air-quality sensor reads high.'),
      DropdownButtonFormField<String>(
        initialValue: cfg['sensorDeviceId'] as String?,
        decoration: const InputDecoration(labelText: 'Air-quality sensor'),
        items: [for (final d in sensors) DropdownMenuItem(value: d.id, child: Text(d.name))],
        onChanged: (v) => setState(() => cfg['sensorDeviceId'] = v),
      ),
      DropdownButtonFormField<String>(
        initialValue: cfg['fanDeviceId'] as String?,
        decoration: const InputDecoration(labelText: 'Fan'),
        items: [for (final d in fans) DropdownMenuItem(value: d.id, child: Text(d.name))],
        onChanged: (v) => setState(() => cfg['fanDeviceId'] = v),
      ),
      Row(children: [
        Expanded(child: TextFormField(
          initialValue: cfg['highThreshold']?.toString(),
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Turn on above'),
          onChanged: (v) => cfg['highThreshold'] = num.tryParse(v),
        )),
        const SizedBox(width: 8),
        Expanded(child: TextFormField(
          initialValue: cfg['lowThreshold']?.toString(),
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Turn off below'),
          onChanged: (v) => cfg['lowThreshold'] = num.tryParse(v),
        )),
      ]),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () {
          if (cfg['sensorDeviceId'] == null || cfg['fanDeviceId'] == null) { _toast('Pick a sensor and a fan.'); return; }
          _run(() => _c.setVentilation({
                'sensorDeviceId': cfg['sensorDeviceId'],
                'fanDeviceId': cfg['fanDeviceId'],
                if (cfg['highThreshold'] != null) 'highThreshold': cfg['highThreshold'],
                if (cfg['lowThreshold'] != null) 'lowThreshold': cfg['lowThreshold'],
              }), 'Ventilation configured');
        },
        child: const Text('Save ventilation'),
      ),
    ]);
  }

  // ── Energy tariff ────────────────────────────────────────────────────────────
  Widget _tariffPanel() {
    final t = _tariff!;
    final periods = (t['periods'] as List).cast<Map<String, dynamic>>();
    return _panel('Energy tariff', 'Time-of-use rate plan', [
      Row(children: [
        SizedBox(width: 90, child: TextFormField(
          initialValue: t['currency'] as String?,
          decoration: const InputDecoration(labelText: 'Currency'),
          onChanged: (v) => t['currency'] = v,
        )),
        const SizedBox(width: 8),
        Expanded(child: TextFormField(
          initialValue: (t['standingChargePerDay'] ?? 0).toString(),
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Standing charge/day'),
          onChanged: (v) => t['standingChargePerDay'] = num.tryParse(v) ?? 0,
        )),
      ]),
      for (final p in periods) ...[
        const SizedBox(height: 8),
        Row(children: [
          Expanded(child: TextFormField(
            initialValue: p['name'] as String?,
            decoration: const InputDecoration(labelText: 'Period'),
            onChanged: (v) => p['name'] = v,
          )),
          const SizedBox(width: 8),
          SizedBox(width: 110, child: TextFormField(
            initialValue: (p['ratePerKwh'] as num).toString(),
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(labelText: '/kWh'),
            onChanged: (v) => p['ratePerKwh'] = num.tryParse(v) ?? 0,
          )),
        ]),
        Wrap(spacing: 4, runSpacing: 4, children: [
          for (var h = 0; h < 24; h++)
            _HourChip(
              hour: h,
              on: (p['hours'] as List).contains(h),
              onTap: () => setState(() {
                final hrs = (p['hours'] as List);
                if (hrs.contains(h)) { hrs.remove(h); } else { hrs.add(h); hrs.sort(); }
              }),
            ),
        ]),
      ],
      const SizedBox(height: 8),
      FilledButton(onPressed: () => _run(() => _c.setTariff(t), 'Tariff saved'), child: const Text('Save tariff')),
    ]);
  }

  // ── Provider ─────────────────────────────────────────────────────────────────
  Widget _providerPanel() {
    final p = _provider ??= {};
    return _panel('Electricity provider & rate', p['ratePerKwh'] != null ? '${p['ratePerKwh']} ${p['currency']}/kWh' : 'Not set', [
      const Text('Powers the per-room / per-device cost views.'),
      TextFormField(
        initialValue: p['country'] as String?,
        decoration: const InputDecoration(labelText: 'Country (e.g. US, IN, AE)'),
        onChanged: (v) => p['country'] = v,
      ),
      TextFormField(
        initialValue: p['city'] as String?,
        decoration: const InputDecoration(labelText: 'City (optional)'),
        onChanged: (v) => p['city'] = v,
      ),
      Row(children: [
        Expanded(child: TextFormField(
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(labelText: 'Manual rate /kWh (optional)'),
          onChanged: (v) => p['ratePerKwh'] = num.tryParse(v),
        )),
        const SizedBox(width: 8),
        SizedBox(width: 90, child: TextFormField(
          decoration: const InputDecoration(labelText: 'Cur.'),
          onChanged: (v) => p['currency'] = v,
        )),
      ]),
      const SizedBox(height: 8),
      FilledButton(
        onPressed: () => _run(() async {
          final r = await _c.setEnergyProvider(
            country: (p['country'] as String?) ?? '',
            city: p['city'] as String?,
            ratePerKwh: (p['ratePerKwh'] as num?)?.toDouble(),
            currency: p['currency'] as String?,
          );
          setState(() => _provider = r);
        }, 'Provider saved'),
        child: const Text('Save provider'),
      ),
    ]);
  }

  // ── Load-shifting ────────────────────────────────────────────────────────────
  Widget _loadShiftPanel() {
    num? ceiling;
    return _panel('Peak load-shifting', '${_deferrable.length} selected', [
      const Text('Devices the hub may pause during peak-rate hours (e.g. water heater, EV charger, pool pump).'),
      Wrap(spacing: 6, runSpacing: 6, children: [
        for (final d in _devices)
          FilterChip(
            label: Text(d.name),
            selected: _deferrable.contains(d.id),
            onSelected: (s) => setState(() => s ? _deferrable.add(d.id) : _deferrable.remove(d.id)),
          ),
      ]),
      TextFormField(
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(labelText: 'Only pause when the rate is above /kWh (optional)'),
        onChanged: (v) => ceiling = num.tryParse(v),
      ),
      const SizedBox(height: 8),
      FilledButton(onPressed: () => _run(() => _c.setDeferrableLoads(_deferrable, ceiling: ceiling), 'Load-shifting saved'), child: const Text('Save load-shifting')),
    ]);
  }

  String _fmt(int m) => '${(m ~/ 60).toString().padLeft(2, '0')}:${(m % 60).toString().padLeft(2, '0')}';
}

class _HourChip extends StatelessWidget {
  const _HourChip({required this.hour, required this.on, required this.onTap});
  final int hour;
  final bool on;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(6),
      child: Container(
        width: 26, height: 26, alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? scheme.primary : Colors.transparent,
          border: Border.all(color: on ? Colors.transparent : scheme.outlineVariant),
          borderRadius: BorderRadius.circular(6),
        ),
        child: Text('$hour', style: TextStyle(fontSize: 11, color: on ? scheme.onPrimary : scheme.onSurfaceVariant)),
      ),
    );
  }
}
