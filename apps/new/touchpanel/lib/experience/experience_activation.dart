import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

/// Demonstrates real requested-vs-confirmed state (§Phase8-14): tapping an
/// Experience shows "Applying…" immediately, then transitions to the
/// Experience name once the (mocked) Hub confirms — never silently claims
/// success from the tap alone. The delay stands in for a real Hub
/// round-trip (§43); the state machine itself (`ConfirmationState`) is real
/// and shared with every other domain control.
class ExperienceActivation extends StatefulWidget {
  final String name;
  final bool enabled;
  const ExperienceActivation(
      {super.key, required this.name, this.enabled = true});

  @override
  State<ExperienceActivation> createState() => _ExperienceActivationState();
}

class _ExperienceActivationState extends State<ExperienceActivation> {
  ConfirmationState _state = ConfirmationState.confirmed;

  Future<void> _activate() async {
    if (!widget.enabled) return;
    setState(() => _state = ConfirmationState.requested);
    await Future.delayed(const Duration(milliseconds: 400));
    if (!mounted) return;
    setState(() => _state = ConfirmationState.confirmed);
  }

  @override
  Widget build(BuildContext context) {
    final label = switch (_state) {
      ConfirmationState.requested => 'Applying…',
      ConfirmationState.confirmed => widget.name,
      ConfirmationState.failed => 'Unavailable',
    };
    return ExperienceControl(name: label, onActivate: _activate);
  }
}
