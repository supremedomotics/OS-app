import 'dart:ui' as ui;

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:supreme_mobile_next/features/onboarding/field_panel.dart';
import 'package:supreme_mobile_next/features/onboarding/presence_engine.dart';

/// The ported Presence v11 against the numbers of `SupremeOS_Onboarding_frozen.html`. The pixel
/// comparison with the original lives in `tools/golden-master-verify`; these pin the clock and the
/// phase boundaries, which are what the choreography is made of.
void main() {
  group('phase boundaries (PRE / POST)', () {
    test('the fixed pre-response phases', () {
      final t = PresenceTimeline();
      expect(t.presence, 1200);
      expect(t.reach, 3100);
      expect(PresenceTimeline.minStill, 3900);
    });

    test('everything after the response is placed relative to it', () {
      final t = PresenceTimeline()..place(3900);
      expect(t.still, 3900);
      expect(t.response, 3900 + 1150);
      expect(t.two, 3900 + 1150 + 850);
      expect(t.approach, 3900 + 1150 + 850 + 1150);
      expect(t.datum, 3900 + 1150 + 850 + 1150 + 500);
      expect(t.coherence, 3900 + 1150 + 850 + 1150 + 500 + 1100);
      expect(t.arrival, 3900 + 1150 + 850 + 1150 + 500 + 1100 + 500);
      expect(t.calm, 3900 + 1150 + 850 + 1150 + 500 + 1100 + 500 + 450);
      expect(t.end, t.calm + 1200);
      expect(t.end, 10800);
    });

    test('until the Hub answers, nothing after the stillness exists', () {
      final t = PresenceTimeline()..place(double.infinity);
      expect(t.still, double.infinity);
      expect(t.end, double.infinity);
    });
  });

  group('the clock', () {
    test('without an answer it holds in stillness and never finishes', () {
      final c = PresenceClock();
      var finished = false;
      for (var i = 0; i < 1000; i++) {
        finished |= c.tick(16);
      }
      expect(finished, isFalse);
      expect(c.vt, closeTo(16000, 1));
      expect(c.timeline.still.isInfinite, isTrue);
    });

    test('a frame never advances more than 50 ms — a backgrounded app resumes calmly',
        () {
      final c = PresenceClock()..tick(10000);
      expect(c.vt, 50);
    });

    test('the response begins no earlier than the minimum stillness', () {
      final c = PresenceClock();
      for (var i = 0; i < 20; i++) {
        c.tick(50); // 1 s
      }
      c.hubResponded(); // answers early, at ~1 s
      c.tick(50);
      c.tick(50);
      // Placement happens on the first tick after the signal and is clamped up to 3900.
      expect(c.timeline.still, 3900);
      expect(c.timeline.end, 10800);
    });

    test('an answer that comes later is placed where it came', () {
      final c = PresenceClock();
      for (var i = 0; i < 100; i++) {
        c.tick(50); // 5 s
      }
      c.hubResponded();
      c.tick(50);
      expect(c.timeline.still, closeTo(5050, 60));
      expect(c.timeline.end, closeTo(5050 + 6900, 60));
    });

    test('already answered: the pre-response plays 1.5×, never skipped', () {
      final c = PresenceClock()..hubResponded();
      c.tick(40);
      expect(c.vt, 60); // 40 × 1.5
      for (var i = 0; i < 100; i++) {
        c.tick(50);
      }
      expect(c.vt, greaterThan(PresenceTimeline.preReach));
    });

    test('it finishes exactly once the whole choreography has played', () {
      final c = PresenceClock()..hubResponded();
      var ticks = 0;
      while (!c.tick(50)) {
        ticks++;
        expect(ticks, lessThan(2000));
      }
      expect(c.finished, isTrue);
      expect(c.t, c.timeline.end);
      expect(c.tick(50), isFalse); // and not again
    });

    test('stop() freezes it where it is (no answer: SupremeOS stays alone)', () {
      final c = PresenceClock();
      c.tick(50);
      c.stop();
      final vt = c.vt;
      c.tick(50);
      expect(c.vt, vt);
    });
  });

  group('every phase paints', () {
    final sizes = [
      const Size(390, 844), // portrait layout
      const Size(1440, 900), // landscape
      const Size(844, 390), // compact
    ];

    for (final size in sizes) {
      test('${size.width.toInt()}×${size.height.toInt()}', () {
        final tl = PresenceTimeline()..place(3900);
        // Mid-point of each phase.
        final marks = <double>[
          600, 2000, 3500, // presence · reach · stillness
          4400, 5500, // residence appears · two presences
          6400, 7300, 8000, 9000, // approach · datum · coherence · arrival
          10000, 10800, // calm → welcome · end
        ];
        for (final t in marks) {
          final rec = ui.PictureRecorder();
          final canvas = Canvas(rec);
          PresencePainter(t: t, timeline: tl).paint(canvas, size);
          rec.endRecording().dispose();
        }
      });
    }

    test('the reduced-motion frame is the settled mark and its word', () {
      final rec = ui.PictureRecorder();
      PresencePainter(
              t: 0, timeline: PresenceTimeline(), reduced: true, title: 'Welcome')
          .paint(Canvas(rec), const Size(390, 844));
      rec.endRecording().dispose();
    });
  });

  group('the field panel', () {
    test('tweens critically damped towards its goal and then holds exactly', () {
      final v = FieldPanelValues();
      var moving = true;
      var steps = 0;
      while (moving) {
        moving = v.step(PanelGoal.resting, 16);
        expect(++steps, lessThan(2000));
      }
      expect(v.mark, 1);
      expect(v.a, 1);
      expect(v.b, 0);
    });

    test('never overshoots (no bounce)', () {
      final v = FieldPanelValues();
      for (var i = 0; i < 300; i++) {
        v.step(PanelGoal.resting, 16);
        expect(v.mark, lessThanOrEqualTo(1.0));
      }
    });

    test('one frame is clamped to 50 ms', () {
      final a = FieldPanelValues()..step(PanelGoal.resting, 50);
      final b = FieldPanelValues()..step(PanelGoal.resting, 5000);
      expect(b.mark, a.mark);
    });
  });
}
