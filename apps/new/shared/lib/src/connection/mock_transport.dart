import 'dart:async';
import 'hub_defaults.dart';
import 'transport.dart';

/// Demo/mock Hub used until the real Hub discovery + WSS wiring lands (§43).
/// Behind the same [HubTransport]/[HubDiscovery] interfaces as the real thing
/// — swapping this out is a one-line change at app composition root, never a
/// change to UI code. Uses [SupremeOSHubDefaults.defaultPort] rather than a
/// second hardcoded port number, so this mock can never silently drift from
/// the real default.
class MockHubDiscovery implements HubDiscovery {
  final bool hubPresent;
  const MockHubDiscovery({this.hubPresent = true});

  static const _mockHub = DiscoveredHub(
    identity: HubIdentity(hubId: 'mock-hub-1', displayName: 'SupremeOS Hub'),
    address: '192.168.0.117',
    port: SupremeOSHubDefaults.defaultPort,
  );

  @override
  Future<Uri?> discoverLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    await Future.delayed(const Duration(milliseconds: 300));
    return hubPresent ? _mockHub.controlUri : null;
  }

  @override
  Future<List<DiscoveredHub>> discoverAllLan(
      {Duration timeout = const Duration(seconds: 3)}) async {
    await Future.delayed(const Duration(milliseconds: 300));
    return hubPresent ? const [_mockHub] : const [];
  }
}

class MockHubTransport implements HubTransport {
  /// Set by [connect] only — a socket/TLS handshake completed, but says
  /// nothing about authorization yet.
  bool _socketOpen = false;

  /// Set by [authenticate] only — this is what [isConnected] actually
  /// reflects (§ authentication boundary: "connected" must never mean
  /// anything less than authenticated).
  bool _authenticated = false;

  /// Lets deterministic tests exercise the `authenticationFailed` path
  /// (§Phase9-19) without needing a real rejecting Hub.
  final bool rejectAuthentication;

  MockHubTransport({this.rejectAuthentication = false});

  final _events = StreamController<Map<String, dynamic>>.broadcast();

  @override
  bool get isConnected => _authenticated;

  @override
  Future<void> connect() async {
    await Future.delayed(const Duration(milliseconds: 200));
    _socketOpen = true;
  }

  @override
  Future<void> authenticate() async {
    if (!_socketOpen)
      throw StateError('connect() must succeed before authenticate()');
    await Future.delayed(const Duration(milliseconds: 100));
    if (rejectAuthentication) {
      throw const AuthenticationException(
          'mock Hub rejected device credentials');
    }
    _authenticated = true;
  }

  @override
  Future<void> disconnect() async {
    _socketOpen = false;
    _authenticated = false;
    await _events.close();
  }

  @override
  Future<Map<String, dynamic>> sendCommand(
      String path, Map<String, dynamic> body) async {
    if (!_authenticated) throw StateError('not authenticated');
    return {'ok': true, 'path': path, 'echo': body};
  }

  @override
  Future<Map<String, dynamic>> get(String path) async {
    if (!_authenticated) throw StateError('not authenticated');
    return {'ok': true, 'path': path};
  }

  @override
  Stream<Map<String, dynamic>> events() => _events.stream;
}
