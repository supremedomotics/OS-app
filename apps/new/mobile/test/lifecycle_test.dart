import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/runtime/lifecycle.dart';

void main() {
  group('parseProcessState (§Phase13.1 §4 wire-format parser)', () {
    for (final state in ProcessState.values) {
      test('round-trips ${state.name}', () {
        expect(parseProcessState(state.name), state);
      });
    }

    test('throws on an unknown state string rather than guessing', () {
      expect(() => parseProcessState('flying'), throwsArgumentError);
    });
  });

  group('parseAndroidServiceState (§Phase13.3 wire-format parser)', () {
    for (final state in AndroidServiceState.values) {
      test('round-trips ${state.name}', () {
        expect(parseAndroidServiceState(state.name), state);
      });
    }

    test('throws on an unknown state string rather than guessing', () {
      expect(() => parseAndroidServiceState('exploding'), throwsArgumentError);
    });
  });
}
