import 'package:flutter/material.dart' show Material, MaterialType, TextField, InputDecoration, UnderlineInputBorder, BorderSide, TextInputType;
import 'package:flutter/widgets.dart';
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

  /// Set when this is a sub-page of Settings (its back chip returns there).
  final VoidCallback? onBack;

  const HomeSettingsScreen({
    super.key,
    required this.controller,
    required this.onPair,
    this.activeConnectionManager,
    this.onBack,
  });

  @override
  State<HomeSettingsScreen> createState() => _HomeSettingsScreenState();
}

class _HomeSettingsScreenState extends State<HomeSettingsScreen> {
  // A sentence said after an action (a failed pairing, a duplicate) — presentation only.
  String? _said;

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
    final result = await showDialog2<String>(
      context,
      (_) => _EditHomeNameDialog(initialValue: home.displayName),
    );
    if (result == null) return;
    await widget.controller.renameHome(home.hubId, result);
  }

  Future<void> _remove(PairedHome home) async {
    final confirmed = await showSupremeDialog<bool>(
      context,
      title: 'Forget this Home?',
      body: (c) => Text(
          '"${home.displayName}" will be removed from this device. '
          'This does not revoke your access — you can pair again anytime.',
          style: SupremeTextStyles.resolve(SupremeDensity.comfortable)
              .body
              .copyWith(fontSize: 15, color: SupremeColorScheme.text2)),
      actions: (c) => [
        SupremeAct('Cancel', quiet: true, onTap: () => Navigator.pop(c, false)),
        SupremeAct('Forget Home', danger: true, onTap: () => Navigator.pop(c, true)),
      ],
    );
    if (confirmed == true) await widget.controller.removeHome(home.hubId);
  }

  Future<void> _addHome() async {
    setState(() => _said = null);
    final code = await showDialog2<String>(context, (_) => const _EnterPairingCodeDialog());
    if (code == null || code.trim().isEmpty) return;

    PairHomeResult result;
    try {
      result = await widget.onPair(code.trim());
    } catch (e) {
      if (!mounted) return;
      setState(() => _said = 'Pairing failed: $e');
      return;
    }
    if (widget.controller.homes.any((h) => h.hubId == result.hubId)) {
      if (!mounted) return;
      setState(() => _said = 'This Home is already paired.');
      return;
    }

    if (!mounted) return;
    final name = await showDialog2<String>(
      context,
      (_) => _EditHomeNameDialog(
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
    final text = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    final homes = widget.controller.homes;
    final loaded = widget.controller.isLoaded;

    final children = <Widget>[
      SettingsSubHead(
        back: 'Settings',
        onBack: widget.onBack ?? () => Navigator.of(context).maybePop(),
        kicker: 'Hubs',
        title: 'The residence and its Hubs',
        lede: 'The Homes this device is paired with.',
      ),
    ];
    if (!loaded) {
      children.add(Text('Loading…',
          style: text.body.copyWith(color: SupremeColorScheme.text2)));
    } else if (homes.isEmpty) {
      children.addAll([
        Text('No Home paired yet',
            style: text.name.copyWith(fontSize: 22)),
        const SizedBox(height: 8),
        SupremeAct('+ Add Home', fontSize: 16, onTap: _addHome),
      ]);
    } else {
      for (final home in homes) {
        final active = home.hubId == widget.controller.activeHomeId;
        children.add(Semantics(
          selected: active,
          label: '${home.displayName}, ${_statusFor(home)}${active ? ", selected" : ""}',
          child: Container(
            key: ValueKey('home-${home.hubId}'),
            padding: const EdgeInsets.symmetric(vertical: 18),
            decoration: const BoxDecoration(
                border: Border(bottom: BorderSide(color: SupremeColorScheme.rule))),
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(home.displayName, style: text.name.copyWith(fontSize: 24)),
                    const SizedBox(height: 2),
                    Text(_statusFor(home),
                        style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.text3)),
                  ]),
                ),
                if (active)
                  Row(mainAxisSize: MainAxisSize.min, children: [
                    Container(
                        width: 6,
                        height: 6,
                        decoration: const BoxDecoration(
                            shape: BoxShape.circle, color: SupremeColorScheme.brassLight)),
                    const SizedBox(width: 8),
                    Text('Selected',
                        style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.brassPale)),
                  ]),
              ]),
              Wrap(spacing: 8, children: [
                if (!active)
                  SupremeAct('Use ${home.displayName}',
                      onTap: () => widget.controller.setActiveHome(home.hubId)),
                SupremeAct('Rename', quiet: true, onTap: () => _editName(home)),
                SupremeAct('Forget', quiet: true, onTap: () => _remove(home)),
              ]),
              // §Phase12.10 §3 — homeowner-relevant concepts only: no broker URL, public key,
              // bearer token, or tunnel/routing detail ever appears here. OFF by default per
              // Home; never toggled by anything but this explicit switch.
              Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text('Remote Access', style: text.name.copyWith(fontSize: 19)),
                    Text('Keep this Home reachable when your phone is away from its local network.',
                        style: text.body.copyWith(fontSize: 13, color: SupremeColorScheme.text3)),
                  ]),
                ),
                SupremeSwitch(
                  key: ValueKey('remote-${home.hubId}'),
                  on: home.remoteAccessEnabled,
                  label: 'Remote Access',
                  showWord: false,
                  onTap: () => widget.controller
                      .setRemoteAccessEnabled(home.hubId, !home.remoteAccessEnabled),
                ),
              ]),
            ]),
          ),
        ));
      }
      children.add(Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Align(
            alignment: Alignment.centerLeft,
            child: SupremeAct('+ Add Home', fontSize: 16, onTap: _addHome)),
      ));
    }
    if (_said != null) {
      children.add(Padding(
        padding: const EdgeInsets.only(top: 16),
        child: Text(_said!,
            key: const ValueKey('settings-said'),
            style: text.body.copyWith(fontSize: 14, color: SupremeColorScheme.brassPale)),
      ));
    }
    return SupremePage(key: const ValueKey('hubs-page'), children: children);
  }
}

/// Runs a dialog whose body is a stateful widget popping a value.
Future<T?> showDialog2<T>(BuildContext context, WidgetBuilder builder) =>
    showGeneralDialog<T>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Close',
      barrierColor: SupremeColorScheme.veil,
      transitionDuration: const Duration(milliseconds: 250),
      pageBuilder: (c, _, __) => SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Material(
              type: MaterialType.transparency,
              child: Container(
                margin: const EdgeInsets.all(20),
                padding: const EdgeInsets.fromLTRB(24, 22, 24, 12),
                decoration: BoxDecoration(
                  color: SupremeColorScheme.glassSolid,
                  borderRadius: BorderRadius.circular(8),
                  border: Border.all(color: SupremeColorScheme.glassEdge),
                ),
                child: builder(c),
              ),
            ),
          ),
        ),
      ),
    );

InputDecoration _fieldDecoration(String label, {String? error}) => InputDecoration(
      labelText: label,
      errorText: error,
      labelStyle: const TextStyle(color: SupremeColorScheme.text3),
      enabledBorder: const UnderlineInputBorder(
          borderSide: BorderSide(color: SupremeColorScheme.rule)),
      focusedBorder: const UnderlineInputBorder(
          borderSide: BorderSide(color: SupremeColorScheme.brass)),
      counterStyle: const TextStyle(color: SupremeColorScheme.text3),
    );

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
    final t = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text(widget.title, style: t.name.copyWith(fontSize: 24)),
      const SizedBox(height: 12),
      TextField(
        controller: _controller,
        autofocus: true,
        maxLength: HomeNameValidation.maxLength,
        style: t.body,
        cursorColor: SupremeColorScheme.brassLight,
        decoration: _fieldDecoration('Home name', error: _error),
        onSubmitted: (_) => _submit(),
      ),
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        SupremeAct('Cancel', quiet: true, onTap: () => Navigator.pop(context)),
        const SizedBox(width: 8),
        SupremeAct('Save', onTap: _submit),
      ]),
    ]);
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
    final t = SupremeTextStyles.resolve(SupremeDensity.comfortable);
    return Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.start, children: [
      Text('Add Home', style: t.name.copyWith(fontSize: 24)),
      const SizedBox(height: 12),
      TextField(
        controller: _controller,
        autofocus: true,
        keyboardType: TextInputType.number,
        style: t.body,
        cursorColor: SupremeColorScheme.brassLight,
        decoration: _fieldDecoration('Enter the pairing code shown on your Hub'),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      const SizedBox(height: 8),
      Row(mainAxisAlignment: MainAxisAlignment.end, children: [
        SupremeAct('Cancel', quiet: true, onTap: () => Navigator.pop(context)),
        const SizedBox(width: 8),
        SupremeAct('Continue', onTap: () => Navigator.pop(context, _controller.text)),
      ]),
    ]);
  }
}
