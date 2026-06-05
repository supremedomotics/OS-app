import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers.dart';

/// AI assistant (§10): type a request, get a Supreme DSL draft to confirm. The
/// assistant runs on the hub and works offline.
class AssistantScreen extends ConsumerStatefulWidget {
  const AssistantScreen({super.key});

  @override
  ConsumerState<AssistantScreen> createState() => _AssistantScreenState();
}

class _AssistantScreenState extends ConsumerState<AssistantScreen> {
  final _controller = TextEditingController();
  Map<String, dynamic>? _result;
  bool _busy = false;

  Future<void> _send() async {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    setState(() => _busy = true);
    try {
      final result = await ref.read(clientProvider).aiAssist(text);
      setState(() => _result = result);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Assistant')),
      body: Padding(
        padding: const EdgeInsets.all(AureonSpacing.lg),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
                'Ask Supreme to set a scene, control a device, or build an automation.',
                style: Theme.of(context).textTheme.labelMedium),
            const SizedBox(height: AureonSpacing.md),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _controller,
                    decoration: const InputDecoration(
                      hintText: 'e.g. dim the living room lights to 20%',
                    ),
                    onSubmitted: (_) => _send(),
                  ),
                ),
                const SizedBox(width: AureonSpacing.sm),
                IconButton.filled(
                  onPressed: _busy ? null : _send,
                  icon: const Icon(Icons.send),
                ),
              ],
            ),
            const SizedBox(height: AureonSpacing.lg),
            if (_busy) const Center(child: CircularProgressIndicator()),
            if (_result != null && !_busy)
              Expanded(
                child: Card(
                  child: Padding(
                    padding: const EdgeInsets.all(AureonSpacing.md),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Chip(label: Text('Draft: ${_result!['kind']}')),
                        const SizedBox(height: AureonSpacing.sm),
                        Text(_result!['summary'] as String? ?? '',
                            style: Theme.of(context).textTheme.bodyLarge),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
