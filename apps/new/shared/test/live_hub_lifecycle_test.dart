@Tags(['live-hub'])
@TestOn('vm')
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:supreme_os_core/supreme_os_core.dart';
import 'package:test/test.dart';

/// The whole client stack against the REAL gateway (Phase 3 closure gate).
///
/// `services/gateway/tools/test-hub.ts` starts the production gateway — Fastify REST, the `/v1/stream`
/// WebSocket, the SIL, the state feed and the Hub's scene runner — on a random port, authorised the
/// way a paired Mobile is. The client side is the production code: `HttpHubTransport`,
/// `WebSocketHubEventStream`, `ResidenceState`, `CommandTracker`, `ExperienceActivations`. Nothing
/// on the client side of the wire is faked.
///
/// HONEST SCOPE: the gateway's device layer here is its built-in mock backend (devices that accept
/// commands and report state through the same SIL/state-feed path a driver uses). No physical
/// hardware is involved. What this proves is request → Hub → device report → stream → ResidenceState
/// reconciliation on the real transport; it does not prove any specific protocol driver.
///
/// Skipped (loudly) only when the gateway's dependencies are not installed (`pnpm install`, `pnpm
/// -r build`). Run: `dart test -t live-hub`.
class _Hub {
  final Process process;
  final Uri baseUrl;
  final Uri streamUrl;
  final String token;
  final String ownerEmail;
  final String ownerPassword;
  _Hub(this.process, this.baseUrl, this.streamUrl, this.token, this.ownerEmail, this.ownerPassword);

  Future<void> stop() async {
    process.kill(ProcessSignal.sigterm);
    await process.exitCode.timeout(const Duration(seconds: 10), onTimeout: () {
      process.kill(ProcessSignal.sigkill);
      return -1;
    });
  }
}

Future<_Hub?> _startHub() async {
  final dir = Directory('../../../services/gateway');
  final tsx = File('${dir.path}/node_modules/.bin/tsx');
  if (!tsx.existsSync()) return null;
  // Absolute: a relative executable is resolved against `workingDirectory`, not this process's.
  final p = await Process.start(tsx.absolute.path, ['tools/test-hub.ts'],
      workingDirectory: dir.absolute.path);
  unawaited(p.stderr.drain<void>());
  final line = await p.stdout
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .firstWhere((l) => l.startsWith('{'))
      .timeout(const Duration(seconds: 90));
  final j = jsonDecode(line) as Map<String, dynamic>;
  final login = j['ownerLogin'] as Map<String, dynamic>;
  return _Hub(p, Uri.parse('${j['baseUrl']}/'), Uri.parse(j['streamUrl'] as String),
      j['token'] as String, login['email'] as String, login['password'] as String);
}

Future<void> _until(bool Function() cond, String what,
    {Duration timeout = const Duration(seconds: 30)}) async {
  final end = DateTime.now().add(timeout);
  while (!cond()) {
    if (DateTime.now().isAfter(end)) fail('timed out waiting for: $what');
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
}

void main() {
  _Hub? hub;
  late http.Client client;

  setUpAll(() async {
    client = http.Client();
    hub = await _startHub();
    if (hub == null) {
      // ignore: avoid_print
      print('SKIPPED: services/gateway dependencies are not installed (pnpm install && pnpm -r build).');
    }
  });
  tearDownAll(() async {
    client.close();
    await hub?.stop();
  });

  Future<Map<String, dynamic>> restGet(String path, String bearer) async {
    final res = await client.get(hub!.baseUrl.resolve(path), headers: {'authorization': 'Bearer $bearer'});
    expect(res.statusCode, 200, reason: '$path → ${res.body}');
    return jsonDecode(res.body) as Map<String, dynamic>;
  }

  test('command and Experience lifecycles, request → Hub → device report → ResidenceState', () async {
    if (hub == null) return markTestSkipped('gateway dependencies not installed');
    final h = hub!;

    // The Hub's own authoring path: an owner writes an Experience with a line and phases.
    final loginRes = await client.post(h.baseUrl.resolve('v1/auth/login'),
        headers: {'content-type': 'application/json'},
        body: jsonEncode({'email': h.ownerEmail, 'password': h.ownerPassword}));
    final owner = (jsonDecode(loginRes.body) as Map<String, dynamic>)['accessToken'] as String;
    final devicesJson = (await restGet('v1/devices', h.token))['devices'] as List;
    final byRoom = <String, Map<String, dynamic>>{};
    for (final d in devicesJson.cast<Map<String, dynamic>>()) {
      final caps = [for (final c in d['capabilities'] as List) (c as Map)['kind']];
      if (d['roomId'] == null || !(caps.contains('brightness') || caps.contains('onoff'))) continue;
      byRoom.putIfAbsent(d['roomId'] as String, () => d);
    }
    expect(byRoom.length, greaterThanOrEqualTo(2), reason: 'the mock backend has lights in two rooms');
    final chosen = byRoom.values.take(2).toList();
    Map<String, dynamic> stepFor(Map<String, dynamic> d) {
      final dim = [for (final c in d['capabilities'] as List) (c as Map)['kind']].contains('brightness');
      return dim
          ? {'deviceId': d['id'], 'capability': 'brightness', 'values': {'action': 'set', 'level': 37}}
          : {'deviceId': d['id'], 'capability': 'onoff', 'values': {'action': 'on'}};
    }

    final created = await client.post(h.baseUrl.resolve('v1/scenes'),
        headers: {'content-type': 'application/json', 'authorization': 'Bearer $owner'},
        body: jsonEncode({
          'name': 'Live Probe',
          'scope': 'home',
          'roomId': null,
          'icon': null,
          'steps': [for (final d in chosen) stepFor(d)],
          'description': 'Soft light in two rooms',
          'phases': [
            [0],
            [1]
          ],
        }));
    expect(created.statusCode, 201, reason: created.body);
    final sceneId = ((jsonDecode(created.body) as Map)['scene'] as Map)['id'] as String;

    // A room photograph, uploaded by the owner as the Hub's asset slot allows.
    final png = base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==');
    final photoRoom = chosen.first['roomId'] as String;
    final put = await client.put(h.baseUrl.resolve('v1/rooms/$photoRoom/hero-image'),
        headers: {'content-type': 'application/json', 'authorization': 'Bearer $owner'},
        body: jsonEncode({'dataBase64': base64Encode(png), 'contentType': 'image/png'}));
    expect(put.statusCode, 200, reason: put.body);

    // The client stack, on the real transport.
    final transport = HttpHubTransport(baseUrl: h.baseUrl, bearerToken: () => h.token);
    await transport.authenticate();
    final stream = WebSocketHubEventStream(
        streamUri: h.streamUrl, bearerToken: () => h.token, autoSubscribeRooms: const ['*']);
    final frames = <String>[];
    final streamStates = <HubEventStreamState>[];
    final frameSub = stream.frames.listen((f) => frames.add(f['type'] as String));
    final stateSub = stream.state.listen(streamStates.add);
    // The production wiring: frames feed the state; every live subscription re-reads it.
    final link = ResidenceStreamLink(get: transport.get);
    final state = link.state;
    final tracker = CommandTracker(
      send: (id, c) => transport.sendCommand('v1/devices/$id/command', {'command': c}),
      state: state,
    );
    final activations = ExperienceActivations(post: transport.sendCommand, state: state);
    addTearDown(() async {
      await frameSub.cancel();
      await stateSub.cancel();
      await activations.dispose();
      await tracker.dispose();
      await link.dispose();
    });

    await state.start();
    link.attach(stream);
    await _until(() => streamStates.contains(HubEventStreamState.subscribed),
        'the subscription to go live (the Hub answered the subscribe/ping)');
    expect(state.snapshot.loaded, isTrue);
    expect(state.snapshot.reachable, isTrue);
    final exp = state.snapshot.experiences.firstWhere((e) => e.id == sceneId);
    expect(exp.description, 'Soft light in two rooms');
    expect(exp.phases, [
      [0],
      [1]
    ]);

    // ── Photography: authenticated, versioned, served by the Hub to a paired Mobile ─────────
    final url = state.snapshot.space(photoRoom)!.imageUrl!;
    expect(url, matches(RegExp(r'^/v1/rooms/.+/hero-image\?v=[0-9a-f]{32}$')));
    final store = HeroImageStore(fetch: transport.getBytes);
    expect(await store.load(url), png);
    final refused = await client.get(h.baseUrl.resolve(url.substring(1)),
        headers: {'authorization': 'Bearer junk'});
    expect(refused.statusCode, 401, reason: 'no valid authorization, no picture');

    // ── A. one device command ──────────────────────────────────────────────────────────────
    final d0 = state.snapshot.devices[chosen.first['id']]!;
    final cap = d0.capabilities.containsKey('brightness') ? 'brightness' : 'onoff';
    final wasOn = (d0.state[cap]?['on']) == true;
    final phases = <CommandPhase>[];
    final tSub = tracker.updates.listen((r) {
      if (r.deviceId == d0.id) phases.add(r.phase);
    });
    final rec = tracker.submit(d0.id, {'capability': cap, 'action': wasOn ? 'off' : 'on'});
    expect(rec.phase, CommandPhase.requested);
    String diag() {
      final r = tracker.latestFor(d0.id, cap);
      return 'record=${r?.phase}/${r?.failure} frames=$frames stream=$streamStates '
          'device=${state.snapshot.devices[d0.id]?.state[cap]}';
    }

    try {
      await _until(() => tracker.latestFor(d0.id, cap)?.phase == CommandPhase.confirmed,
          'the device to report the change on the real stream',
          timeout: const Duration(seconds: 15));
    } catch (e) {
      fail('$e — ${diag()}');
    }
    await tSub.cancel();
    expect(phases.first, CommandPhase.requested);
    expect(phases.last, CommandPhase.confirmed);
    expect(frames, contains('state'), reason: 'confirmation travelled over the real /v1/stream');
    expect(state.snapshot.devices[d0.id]!.state[cap]!['on'], !wasOn);
    // Reconciled with the Hub's own record, read back over REST.
    final back = ((await restGet('v1/devices', h.token))['devices'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((d) => d['id'] == d0.id);
    expect(((back['state'] as Map)[cap] as Map)['on'], !wasOn);

    // ── B. a Hub-orchestrated Experience ───────────────────────────────────────────────────
    final actPhases = <ActivationPhase>[];
    final aSub = activations.updates.listen((a) => actPhases.add(a.phase));
    final a = activations.activate(exp);
    expect(a.phase, ActivationPhase.requested);
    await _until(() => activations.latestFor(sceneId)?.phase == ActivationPhase.confirmed,
        'the Experience to be confirmed by device state');
    await aSub.cancel();
    expect(actPhases.first, ActivationPhase.requested);
    expect(actPhases, contains(ActivationPhase.pending));
    expect(actPhases.last, ActivationPhase.confirmed);

    // The client sent ONE request; the Hub sent the device commands.
    final run = state.snapshot.runs[activations.latestFor(sceneId)!.runId]!;
    await _until(() => !state.snapshot.runs[run.runId]!.isRunning, 'the run to conclude');
    final done = state.snapshot.runs[run.runId]!;
    expect(done.status, RunStatus.completed);
    expect(done.steps.every((s) => s.state == RunStepState.confirmed), isTrue);
    expect(done.phases, 2);
    expect(experienceStatus(exp, state.snapshot).phase, ExperiencePhase.active);

    // Physical reconciliation: every step's device, read back from the Hub, satisfies its step.
    final now = ((await restGet('v1/devices', h.token))['devices'] as List)
        .cast<Map<String, dynamic>>();
    for (final step in exp.steps) {
      final dev = now.firstWhere((d) => d['id'] == step.deviceId);
      final want = expectationOf(step.capability, step.values)!;
      expect(want.matches(((dev['state'] as Map)[step.capability] as Map).cast<String, dynamic>()), isTrue,
          reason: 'device ${step.deviceId} should satisfy ${want.description}');
    }
  }, timeout: const Timeout(Duration(minutes: 3)));
}
