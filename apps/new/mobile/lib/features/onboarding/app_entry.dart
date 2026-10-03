import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../../main.dart';
import 'onboarding_flow.dart';

/// What the app opens to. First run — no Home paired yet — is the arrival/onboarding flow; once a
/// Home is paired (or the Demo has been entered, simulation builds only) it is the residence shell.
///
/// This gate decides only *which surface to show*. It owns no residence state: pairing goes through
/// the existing `pairHomeProvider` / `PairedHomeController`, and Demo is possible only when
/// `simulatedResidenceProvider` is non-null, which is the compile-time
/// `SUPREME_SIMULATED_RESIDENCE` flag and nothing else.
class AppEntry extends ConsumerStatefulWidget {
  const AppEntry({super.key});
  @override
  ConsumerState<AppEntry> createState() => _AppEntryState();
}

class _AppEntryState extends ConsumerState<AppEntry> {
  /// Keeps the "Your residence is ready" screen up after pairing has already written the Home,
  /// so the flow can finish instead of being replaced by the shell mid-sentence.
  bool _hold = false;

  @override
  Widget build(BuildContext context) {
    final homes = ref.watch(pairedHomeControllerProvider);
    final demoEntered = ref.watch(demoEnteredProvider);
    return ListenableBuilder(
      listenable: homes,
      builder: (context, _) {
        // Until the paired-Home store has answered, show neither surface: an already-paired
        // person must never see the arrival flow flash by.
        if (!homes.isLoaded) {
          return const ColoredBox(color: SupremeColorScheme.night);
        }
        final arriving = _hold || (homes.homes.isEmpty && !demoEntered);
        if (arriving) {
          return OnboardingFlow(onHold: (hold) => setState(() => _hold = hold));
        }
        return const RootShell();
      },
    );
  }
}
