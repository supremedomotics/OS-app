import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// First-boot provisioning UI (§6). Deliberately simple: one question, one
/// choice, one confirm. Never exposed again once provisioned (§7) — the
/// caller only mounts this widget when [ProvisioningController] has no
/// stored assignment yet.
class ProvisioningFlow extends StatefulWidget {
  final ProvisioningController controller;
  final void Function(PanelConfig) onProvisioned;
  const ProvisioningFlow(
      {super.key, required this.controller, required this.onProvisioned});

  @override
  State<ProvisioningFlow> createState() => _ProvisioningFlowState();
}

class _ProvisioningFlowState extends State<ProvisioningFlow> {
  ControlScope? _scope;
  List<AreaSummary>? _areas;
  AreaSummary? _selectedArea;
  bool _confirming = false;

  Future<void> _pickScope(ControlScope scope) async {
    setState(() => _scope = scope);
    if (scope == ControlScope.wholeHome) return;
    final areas = await widget.controller.fetchAreas();
    setState(() => _areas = areas);
  }

  Future<void> _confirm() async {
    setState(() => _confirming = true);
    final assignment = PanelAssignment(
      scope: _scope!,
      projectId:
          'current-project', // Hub supplies the real projectId at auth time
      configurationVersion: 1,
      assignedRoomId: _scope == ControlScope.room ? _selectedArea!.id : null,
      assignedRoomName:
          _scope == ControlScope.room ? _selectedArea!.name : null,
      assignedAreaId: _scope == ControlScope.floor ? _selectedArea!.id : null,
      assignedAreaName:
          _scope == ControlScope.floor ? _selectedArea!.name : null,
    );
    final config = await widget.controller.completeProvisioning(assignment);
    widget.onProvisioned(config);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: SupremeColorScheme.voidBg,
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 560),
          child: _confirming
              ? const CircularProgressIndicator(
                  color: SupremeColorScheme.gold500)
              : _scope == null
                  ? _ScopeStep(onPick: _pickScope)
                  : _scope == ControlScope.wholeHome
                      ? _ConfirmStep(label: 'Whole Home', onConfirm: _confirm)
                      : _AreaStep(
                          areas: _areas,
                          selected: _selectedArea,
                          onSelect: (a) => setState(() => _selectedArea = a),
                          onConfirm: _selectedArea == null ? null : _confirm,
                        ),
        ),
      ),
    );
  }
}

class _ScopeStep extends StatelessWidget {
  final void Function(ControlScope) onPick;
  const _ScopeStep({required this.onPick});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text('How should this panel control your home?',
              textAlign: TextAlign.center,
              style: TextStyle(
                  color: SupremeColorScheme.textPrimary,
                  fontSize: 26,
                  fontWeight: FontWeight.w600)),
          const SizedBox(height: 32),
          _ScopeOption(
              title: 'Room Control',
              subtitle: 'Control one room.',
              onTap: () => onPick(ControlScope.room)),
          _ScopeOption(
              title: 'Floor Control',
              subtitle: 'Control spaces on one floor.',
              onTap: () => onPick(ControlScope.floor)),
          _ScopeOption(
              title: 'Whole Home',
              subtitle: 'Control the residence.',
              onTap: () => onPick(ControlScope.wholeHome)),
        ],
      ),
    );
  }
}

class _ScopeOption extends StatelessWidget {
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  const _ScopeOption(
      {required this.title, required this.subtitle, required this.onTap});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(16),
        child: Container(
          padding: const EdgeInsets.all(24),
          decoration: BoxDecoration(
            color: SupremeColorScheme.surface,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: SupremeColorScheme.hairline),
          ),
          child:
              Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title,
                style: const TextStyle(
                    color: SupremeColorScheme.textPrimary,
                    fontSize: 20,
                    fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(subtitle,
                style: const TextStyle(
                    color: SupremeColorScheme.textSecondary, fontSize: 14)),
          ]),
        ),
      ),
    );
  }
}

class _AreaStep extends StatelessWidget {
  final List<AreaSummary>? areas;
  final AreaSummary? selected;
  final void Function(AreaSummary) onSelect;
  final VoidCallback? onConfirm;
  const _AreaStep(
      {required this.areas,
      required this.selected,
      required this.onSelect,
      required this.onConfirm});

  @override
  Widget build(BuildContext context) {
    if (areas == null) {
      return const CircularProgressIndicator(color: SupremeColorScheme.gold500);
    }
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Which room is this panel for?',
                textAlign: TextAlign.center,
                style: TextStyle(
                    color: SupremeColorScheme.textPrimary,
                    fontSize: 26,
                    fontWeight: FontWeight.w600)),
            const SizedBox(height: 24),
            RadioGroup<AreaSummary>(
              groupValue: selected,
              onChanged: (a) => onSelect(a!),
              child: Column(
                children: [
                  for (final area in areas!)
                    RadioListTile<AreaSummary>(
                      value: area,
                      title: Text(area.name,
                          style: const TextStyle(
                              color: SupremeColorScheme.textPrimary)),
                      activeColor: SupremeColorScheme.gold500,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 16),
            FilledButton(onPressed: onConfirm, child: const Text('Confirm')),
          ]),
    );
  }
}

class _ConfirmStep extends StatelessWidget {
  final String label;
  final VoidCallback onConfirm;
  const _ConfirmStep({required this.label, required this.onConfirm});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(32),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('This panel will control: $label',
            textAlign: TextAlign.center,
            style: const TextStyle(
                color: SupremeColorScheme.textPrimary, fontSize: 22)),
        const SizedBox(height: 24),
        FilledButton(onPressed: onConfirm, child: const Text('Confirm')),
      ]),
    );
  }
}
