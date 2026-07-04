import 'dart:convert';

import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../cloud/multi_home.dart';

/// Add-a-home setup screen (blueprint §16): register another Supreme hub by name + address. Mirrors
/// the web Settings → Homes → Add flow. The new home is appended to [homesProvider] and made active,
/// so every screen rebinds to it immediately. A "Test connection" probe hits the hub's unauthenticated
/// setup-status endpoint so the installer knows the address is right before saving.
class AddHomeScreen extends ConsumerStatefulWidget {
  const AddHomeScreen({super.key});

  @override
  ConsumerState<AddHomeScreen> createState() => _AddHomeScreenState();
}

class _AddHomeScreenState extends ConsumerState<AddHomeScreen> {
  final _name = TextEditingController();
  final _url = TextEditingController(text: 'http://');
  bool _busy = false;
  ({bool ok, String text})? _check;

  @override
  void dispose() {
    _name.dispose();
    _url.dispose();
    super.dispose();
  }

  String _normalized() {
    var t = _url.text.trim().replaceAll(RegExp(r'/$'), '');
    if (t.isEmpty) return t;
    if (!RegExp(r'^https?://', caseSensitive: false).hasMatch(t)) t = 'http://$t';
    return t;
  }

  Future<void> _test() async {
    final url = _normalized();
    if (url.isEmpty) return;
    setState(() { _busy = true; _check = null; });
    try {
      final res = await http
          .get(Uri.parse('$url/v1/setup/status'))
          .timeout(const Duration(seconds: 5));
      if (res.statusCode < 400) {
        final name = (jsonDecode(res.body) as Map<String, dynamic>)['systemName'] as String?;
        setState(() => _check = (ok: true, text: 'Reachable${name != null && name.isNotEmpty ? ' · $name' : ''}'));
      } else {
        setState(() => _check = (ok: false, text: "Couldn't reach a Supreme hub there."));
      }
    } catch (_) {
      setState(() => _check = (ok: false, text: "Couldn't reach a Supreme hub there."));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _save() {
    final url = _normalized();
    if (url.isEmpty) return;
    final hubId = 'hub_${url.hashCode.abs()}';
    final name = _name.text.trim().isEmpty ? url.replaceFirst(RegExp(r'^https?://'), '') : _name.text.trim();
    // A manually-added hub is reached directly at the given address (treated as its local route).
    final home = HomeRef(hubId: hubId, name: name, role: 'owner', cloudRouteUrl: url, localBaseUrl: url);
    final homes = [...ref.read(homesProvider)].where((h) => h.hubId != hubId).toList()..add(home);
    ref.read(homesProvider.notifier).state = homes;
    ref.read(activeHomeIdProvider.notifier).state = hubId;
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Add a home')),
      body: ListView(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        children: [
          Text('Register another Supreme hub', style: text.titleMedium),
          const SizedBox(height: AureonSpacing.sm),
          Text('Each home is one hub. After adding it, switch between homes from the switcher or Settings.',
              style: text.labelMedium),
          const SizedBox(height: AureonSpacing.lg),
          TextField(
            controller: _name,
            decoration: const InputDecoration(labelText: 'Home name', hintText: 'e.g. Dubai Apartment'),
          ),
          const SizedBox(height: AureonSpacing.md),
          TextField(
            controller: _url,
            keyboardType: TextInputType.url,
            decoration: const InputDecoration(labelText: 'Hub address', hintText: 'http://192.168.1.20:8080'),
            onChanged: (_) => setState(() => _check = null),
          ),
          if (_check != null)
            Padding(
              padding: const EdgeInsets.only(top: AureonSpacing.sm),
              child: Text(
                _check!.text,
                style: text.labelMedium?.copyWith(
                  color: _check!.ok ? AureonStatus.good : AureonStatus.critical,
                ),
              ),
            ),
          const SizedBox(height: AureonSpacing.lg),
          Row(children: [
            OutlinedButton(onPressed: _busy ? null : _test, child: Text(_busy ? 'Checking…' : 'Test connection')),
            const SizedBox(width: AureonSpacing.sm),
            FilledButton(onPressed: _save, child: const Text('Add home')),
          ]),
        ],
      ),
    );
  }
}
