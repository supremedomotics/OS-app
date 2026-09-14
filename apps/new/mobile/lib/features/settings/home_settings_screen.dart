import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import 'paired_home_controller.dart';

/// Result of a completed real pairing ceremony (§Phase12.1 §13) — `hubId`/`projectId` come
/// from the Hub's own signed authorization response (Phase 12's `/v1/pairing/verify`), never
/// typed in by the user (§13: "do not add a Home to the list merely because the user typed a
/// Hub ID").
class PairHomeResult {
  final String hubId;
  final String projectId;
  final String? suggestedDisplayName;
  const PairHomeResult(
      {required this.hubId,
      required this.projectId,
      this.suggestedDisplayName});
}

/// Drives the real Phase 11/12 pairing protocol (`PairingClient.pairUsingCode`) for a pairing
/// code the homeowner enters here, returning the genuine authorization result. Composition
/// root supplies the real implementation; see `main.dart`'s honest "PENDING" stub doc comment
/// for what is not yet wired (a live `PairingTransport` to a chosen Hub's LAN address).
typedef PairingCodeHandler = Future<PairHomeResult> Function(
    String pairingCode);

/// Settings → Home (§3/§4) — the ONLY Home-management surface, Mobile/Tablet only. Never
/// shown on Touch Panel (§20 — not imported there at all).
class HomeSettingsScreen extends StatefulWidget {
  final PairedHomeController controller;
  final ConnectionManager? activeConnectionManager;
  final PairingCodeHandler onPair;

  const HomeSettingsScreen({
    super.key,
    required this.controller,
    required this.onPair,
    this.activeConnectionManager,
  });

  @override
  State<HomeSettingsScreen> createState() => _HomeSettingsScreenState();
}

class _HomeSettingsScreenState extends State<HomeSettingsScreen> {
  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onChanged);
    if (!widget.controller.isLoaded) widget.controller.load();
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onChanged);
    super.dispose();
  }

  void _onChanged() => setState(() {});

  Future<void> _editName(PairedHome home) async {
    final result = await showDialog<String>(
      context: context,
      builder: (_) => _EditHomeNameDialog(initialValue: home.displayName),
    );
    if (result == null) return;
    await widget.controller.renameHome(home.hubId, result);
  }

  Future<void> _remove(PairedHome home) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => AlertDialog(
        title: const Text('Forget this Home?'),
        content: Text('"${home.displayName}" will be removed from this device. '
            'This does not revoke your access — you can pair again anytime.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel')),
          TextButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Forget Home')),
        ],
      ),
    );
    if (confirmed == true) await widget.controller.removeHome(home.hubId);
  }

  Future<void> _addHome() async {
    final code = await showDialog<String>(
      context: context,
      builder: (_) => const _EnterPairingCodeDialog(),
    );
    if (code == null || code.trim().isEmpty) return;

    PairHomeResult result;
    try {
      result = await widget.onPair(code.trim());
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text('Pairing failed: $e')));
      return;
    }
    if (widget.controller.homes.any((h) => h.hubId == result.hubId)) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('This Home is already paired.')));
      return;
    }

    if (!mounted) return;
    final name = await showDialog<String>(
      context: context,
      builder: (_) => _EditHomeNameDialog(
        initialValue: result.suggestedDisplayName ?? 'Home',
        title: 'Name your Home',
      ),
    );
    if (name == null) return;
    await widget.controller.addHome(
        hubId: result.hubId, projectId: result.projectId, displayName: name);
  }

  String _statusFor(PairedHome home) {
    if (home.hubId != widget.controller.activeHomeId) return 'Not connected';
    final status = widget.activeConnectionManager?.current.status;
    switch (status) {
      case ConnectionStatus.connectedLocal:
      case ConnectionStatus.connectedRemote:
        return status == ConnectionStatus.connectedRemote
            ? 'Available remotely'
            : 'Connected';
      case ConnectionStatus.offline:
      case null:
        return 'Offline';
      case ConnectionStatus.authenticationFailed:
        return 'Not authorized';
      default:
        return 'Connecting…';
    }
  }

  @override
  Widget build(BuildContext context) {
    final text = SupremeTextStyles.resolve(AdaptiveScope.of(context).density);
    final homes = widget.controller.homes;

    return Scaffold(
      appBar: AppBar(title: const Text('Home')),
      body: !widget.controller.isLoaded
          ? const Center(child: CircularProgressIndicator())
          : homes.isEmpty
              ? Center(
                  child: Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text('No Home paired yet', style: text.body),
                        const SizedBox(height: 16),
                        FilledButton(
                            onPressed: _addHome,
                            child: const Text('+ Add Home')),
                      ],
                    ),
                  ),
                )
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    for (final home in homes)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: Semantics(
                          selected:
                              home.hubId == widget.controller.activeHomeId,
                          label: '${home.displayName}, ${_statusFor(home)}'
                              '${home.hubId == widget.controller.activeHomeId ? ", selected" : ""}',
                          child: Card(
                            child: Column(
                              children: [
                                ListTile(
                                  minVerticalPadding: 16,
                                  title: Text(home.displayName,
                                      style: text.body),
                                  subtitle: Text(_statusFor(home)),
                                  trailing: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      if (home.hubId ==
                                          widget.controller.activeHomeId)
                                        const Icon(Icons.check_circle,
                                            semanticLabel: 'Selected'),
                                      IconButton(
                                        icon: const Icon(Icons.edit_outlined),
                                        tooltip: 'Rename ${home.displayName}',
                                        onPressed: () => _editName(home),
                                      ),
                                      IconButton(
                                        icon:
                                            const Icon(Icons.delete_outline),
                                        tooltip: 'Forget ${home.displayName}',
                                        onPressed: () => _remove(home),
                                      ),
                                    ],
                                  ),
                                  onTap: home.hubId ==
                                          widget.controller.activeHomeId
                                      ? null
                                      : () => widget.controller
                                          .setActiveHome(home.hubId),
                                ),
                                // §Phase12.10 §3 — homeowner-relevant concepts only: no broker
                                // URL, public key, bearer token, or tunnel/routing detail ever
                                // appears here. OFF by default per Home; never toggled by
                                // anything but this explicit switch.
                                SwitchListTile(
                                  value: home.remoteAccessEnabled,
                                  title: const Text('Remote Access'),
                                  subtitle: const Text(
                                      'Keep this Home reachable when your phone is away '
                                      'from its local network.'),
                                  onChanged: (v) => widget.controller
                                      .setRemoteAccessEnabled(home.hubId, v),
                                ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    const SizedBox(height: 8),
                    OutlinedButton(
                        onPressed: _addHome, child: const Text('+ Add Home')),
                  ],
                ),
    );
  }
}

class _EditHomeNameDialog extends StatefulWidget {
  final String initialValue;
  final String title;
  const _EditHomeNameDialog(
      {required this.initialValue, this.title = 'Home name'});

  @override
  State<_EditHomeNameDialog> createState() => _EditHomeNameDialogState();
}

class _EditHomeNameDialogState extends State<_EditHomeNameDialog> {
  late final TextEditingController _controller =
      TextEditingController(text: widget.initialValue);
  String? _error;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  void _submit() {
    final error = HomeNameValidation.validate(_controller.text);
    if (error != null) {
      setState(() => _error = error);
      return;
    }
    Navigator.pop(context, _controller.text);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.title),
      content: TextField(
        controller: _controller,
        autofocus: true,
        maxLength: HomeNameValidation.maxLength,
        decoration: InputDecoration(labelText: 'Home name', errorText: _error),
        onSubmitted: (_) => _submit(),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel')),
        FilledButton(onPressed: _submit, child: const Text('Save')),
      ],
    );
  }
}

class _EnterPairingCodeDialog extends StatefulWidget {
  const _EnterPairingCodeDialog();
  @override
  State<_EnterPairingCodeDialog> createState() =>
      _EnterPairingCodeDialogState();
}

class _EnterPairingCodeDialogState extends State<_EnterPairingCodeDialog> {
  final _controller = TextEditingController();

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Add Home'),
      content: TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: TextInputType.number,
        decoration: const InputDecoration(
            labelText: 'Enter the pairing code shown on your Hub'),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      actions: [
        TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel')),
        FilledButton(
            onPressed: () => Navigator.pop(context, _controller.text),
            child: const Text('Continue')),
      ],
    );
  }
}
