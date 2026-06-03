import 'package:flutter/material.dart';

import '../tokens.g.dart';

/// Slide-to-confirm for sensitive actions (§11.1): unlock doors, arm/disarm
/// security. The chevron handle is dragged to the end to confirm — preventing
/// accidental taps on consequential controls.
class SlideToConfirm extends StatefulWidget {
  const SlideToConfirm({
    super.key,
    required this.label,
    required this.onConfirmed,
    this.icon = Icons.chevron_right,
  });

  final String label;
  final IconData icon;
  final VoidCallback onConfirmed;

  @override
  State<SlideToConfirm> createState() => _SlideToConfirmState();
}

class _SlideToConfirmState extends State<SlideToConfirm> {
  double _dx = 0;
  bool _confirmed = false;

  @override
  Widget build(BuildContext context) {
    const handle = 56.0;
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxDx = constraints.maxWidth - handle;
        return Container(
          height: handle,
          decoration: BoxDecoration(
            color: AureonBase.surfaceOverlay,
            borderRadius: BorderRadius.circular(AureonRadius.pill),
            border: Border.all(color: AureonBase.hairline),
          ),
          child: Stack(
            alignment: Alignment.center,
            children: [
              Text(
                _confirmed ? 'Confirmed' : widget.label,
                style: Theme.of(context).textTheme.labelMedium,
              ),
              Positioned(
                left: _dx.clamp(0, maxDx),
                child: GestureDetector(
                  onHorizontalDragUpdate: (d) => setState(() => _dx += d.delta.dx),
                  onHorizontalDragEnd: (_) {
                    if (_dx >= maxDx * 0.85) {
                      setState(() {
                        _dx = maxDx;
                        _confirmed = true;
                      });
                      widget.onConfirmed();
                    } else {
                      setState(() => _dx = 0);
                    }
                  },
                  child: Container(
                    width: handle,
                    height: handle,
                    decoration: const BoxDecoration(
                      color: AureonGold.c500,
                      shape: BoxShape.circle,
                    ),
                    child: Icon(widget.icon, color: AureonText.inverse),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
