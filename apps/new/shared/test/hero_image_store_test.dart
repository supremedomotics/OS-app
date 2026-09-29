import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

void main() {
  final png = [0x89, 0x50, 0x4e, 0x47, 1, 2, 3];

  test('a Hub-served picture is fetched once, authenticated, and cached by its versioned URL', () async {
    final sim = SimulatedResidence();
    await sim.transport.authenticate();
    sim.setHeroImage('living', png);
    final url = (sim.read('v1/home')['rooms'] as List)
        .firstWhere((r) => r['id'] == 'living')['heroImageUrl'] as String;
    expect(url, startsWith('/v1/rooms/living/hero-image?v='));
    var calls = 0;
    final store = HeroImageStore(fetch: (p, {ifNoneMatch}) {
      calls++;
      return sim.transport.getBytes(p);
    });
    final seen = <String>[];
    store.loaded.listen(seen.add);
    final both = await Future.wait([store.load(url), store.load(url)]);
    expect(both.first, png);
    expect(calls, 1, reason: 'concurrent requests share one fetch');
    expect(store.cached(url), png);
    await store.load(url);
    expect(calls, 1);
    await Future<void>.delayed(Duration.zero);
    expect(seen, [url]);
  });

  test('a changed picture is a new URL, fetched as such', () async {
    final sim = SimulatedResidence();
    await sim.transport.authenticate();
    sim.setHeroImage(null, png);
    final a = (sim.read('v1/home')['home'] as Map)['heroImageUrl'] as String;
    sim.setHeroImage(null, [...png, 9]);
    final b = (sim.read('v1/home')['home'] as Map)['heroImageUrl'] as String;
    expect(a, isNot(b));
    final store = HeroImageStore(fetch: (p, {ifNoneMatch}) => sim.transport.getBytes(p));
    expect(await store.load(b), [...png, 9]);
  });

  test('failure is null, not a stand-in, and is not retried until the pause is over', () async {
    var t = DateTime.utc(2026);
    var calls = 0;
    final store = HeroImageStore(
        now: () => t,
        fetch: (p, {ifNoneMatch}) async {
          calls++;
          throw StateError('unreachable');
        });
    expect(await store.load('/v1/home/hero-image?v=x'), isNull);
    expect(await store.load('/v1/home/hero-image?v=x'), isNull);
    expect(calls, 1);
    t = t.add(const Duration(seconds: 61));
    await store.load('/v1/home/hero-image?v=x');
    expect(calls, 2);
  });

  test('what is not the Hub\'s path is never fetched', () async {
    var calls = 0;
    final store = HeroImageStore(fetch: (p, {ifNoneMatch}) async {
      calls++;
      return const HubBytes(bytes: [1]);
    });
    expect(await store.load('https://elsewhere.example/x.jpg'), isNull);
    expect(await store.load(''), isNull);
    expect(calls, 0);
  });
}
