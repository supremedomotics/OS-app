import 'dart:async';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

const _kLogLevels = ['all', 'error', 'warn', 'info'];

/// Settings → Logs (§ Diagnostics) — mobile parity with the web viewer. One unified,
/// auto-refreshing stream of every driver install/enable/connect/native-connection event plus
/// device control operation outcomes — whether a command actually reached the device, not just
/// that the request was accepted. A silent failure anywhere in the stack becomes a visible,
/// timestamped line here instead of nothing at all.
class LogsScreen extends ConsumerStatefulWidget {
  const LogsScreen({super.key});

  @override
  ConsumerState<LogsScreen> createState() => _LogsScreenState();
}

class _LogsScreenState extends ConsumerState<LogsScreen> {
  List<Map<String, dynamic>>? _entries;
  String _level = 'all';
  bool _auto = true;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _load();
    _armTimer();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _armTimer() {
    _timer?.cancel();
    if (_auto) _timer = Timer.periodic(const Duration(seconds: 5), (_) => _load());
  }

  Future<void> _load() async {
    try {
      final entries = await ref.read(clientProvider).systemLogs(limit: 300);
      if (!mounted) return;
      setState(() => _entries = entries);
    } catch (_) {
      // Best-effort — a transient fetch failure just leaves the last known list on screen.
    }
  }

  Color _levelColor(String level) {
    switch (level) {
      case 'error': return AureonStatus.critical;
      case 'warn': return AureonStatus.warning;
      default: return Colors.grey;
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    final entries = _entries ?? const [];
    final shown = _level == 'all' ? entries : entries.where((e) => e['level'] == _level).toList();

    return Scaffold(
      appBar: AppBar(
        title: const Text('Logs'),
        actions: [
          IconButton(icon: const Icon(Icons.refresh), onPressed: _load),
        ],
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.md, vertical: AureonSpacing.sm),
            child: Row(
              children: [
                Expanded(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: Row(
                      children: [
                        for (final l in _kLogLevels)
                          Padding(
                            padding: const EdgeInsets.only(right: 6),
                            child: ChoiceChip(
                              label: Text(l == 'all' ? 'All' : l == 'error' ? 'Errors' : l == 'warn' ? 'Warnings' : 'Info'),
                              selected: _level == l,
                              onSelected: (_) => setState(() => _level = l),
                            ),
                          ),
                      ],
                    ),
                  ),
                ),
                Switch(
                  value: _auto,
                  onChanged: (v) => setState(() { _auto = v; _armTimer(); }),
                ),
                Text('Auto', style: text.labelSmall),
              ],
            ),
          ),
          Expanded(
            child: _entries == null
                ? const Center(child: CircularProgressIndicator())
                : RefreshIndicator(
                    onRefresh: _load,
                    child: shown.isEmpty
                        ? ListView(children: [Padding(padding: const EdgeInsets.all(AureonSpacing.lg), child: Text('No log entries yet.', style: text.bodyMedium))])
                        : ListView.builder(
                            padding: const EdgeInsets.symmetric(horizontal: AureonSpacing.md),
                            itemCount: shown.length,
                            itemBuilder: (context, i) {
                              final e = shown[i];
                              final level = e['level'] as String? ?? 'info';
                              final ts = DateTime.tryParse(e['ts'] as String? ?? '')?.toLocal();
                              return ListTile(
                                dense: true,
                                contentPadding: EdgeInsets.zero,
                                leading: Text(
                                  level.toUpperCase(),
                                  style: text.labelSmall?.copyWith(color: _levelColor(level), fontWeight: FontWeight.w700),
                                ),
                                title: Text(e['message'] as String? ?? '', style: text.bodyMedium),
                                subtitle: Text(
                                  '${e['source'] ?? ''}${ts != null ? ' · ${ts.hour.toString().padLeft(2, '0')}:${ts.minute.toString().padLeft(2, '0')}:${ts.second.toString().padLeft(2, '0')}' : ''}',
                                  style: text.labelSmall,
                                ),
                              );
                            },
                          ),
                  ),
          ),
        ],
      ),
    );
  }
}
