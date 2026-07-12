import 'package:flutter/material.dart';

/// Shared "Rename device" prompt (§ Design System) — the single canonical implementation of
/// a dialog that was previously duplicated, byte-for-byte, across every device console.
/// Returns the trimmed new name, or `null` if the user cancelled or left it unchanged.
Future<String?> promptRenameDevice(BuildContext context, String currentName) async {
  final ctrl = TextEditingController(text: currentName);
  final name = await showDialog<String>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Rename device'),
      content: TextField(controller: ctrl, autofocus: true, decoration: const InputDecoration(labelText: 'Name')),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.of(ctx).pop(ctrl.text.trim()), child: const Text('Save')),
      ],
    ),
  );
  if (name == null || name.isEmpty || name == currentName) return null;
  return name;
}

/// Shared "Remove device?" confirmation (§ Design System) — the single canonical
/// implementation of a dialog that was previously duplicated, with minor drift, across every
/// device console and list. Returns `true` if the user confirmed removal.
Future<bool> confirmRemoveDevice(BuildContext context, String deviceName) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (ctx) => AlertDialog(
      title: const Text('Remove device?'),
      content: Text('"$deviceName" will be removed. This cannot be undone.'),
      actions: [
        TextButton(onPressed: () => Navigator.of(ctx).pop(false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.of(ctx).pop(true), child: const Text('Remove')),
      ],
    ),
  );
  return ok == true;
}
