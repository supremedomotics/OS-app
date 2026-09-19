/// A panel's own persistent device identity (§Phase9-11) — deliberately NOT
/// a MAC address, and never the sole authentication credential on its own
/// (mirrors [HubIdentity]'s "not just an IP" principle, applied to the
/// client side). Must survive reboot, DHCP change, and network reconnection
/// — which is a property of WHERE the private key material is stored, not
/// of this interface; see [DeviceIdentityStore].
class DeviceIdentity {
  final String deviceId;

  /// Opaque public credential material (e.g. a public key) the Hub can
  /// verify against during enrollment/authentication. Never contains
  /// private key material — that never leaves [DeviceIdentityStore].
  final String publicCredential;

  const DeviceIdentity(
      {required this.deviceId, required this.publicCredential});
}

/// Generates and persists this device's identity, including whatever
/// private key material backs [DeviceIdentity.publicCredential].
///
/// HONEST STATUS (§Phase9-11, §Phase9-21): this is a clean interface with a
/// deterministic in-memory test implementation
/// ([InMemoryDeviceIdentityStore]) — NOT a production implementation. A
/// real Touch Panel build must back this with platform secure storage
/// (Android Keystore / iOS Keychain / a TPM-backed store on desktop) so
/// private key material never touches plain storage; that platform-channel
/// work does not exist yet in this repo and is explicitly NOT claimed as
/// done here. Swapping the real implementation in is a one-line change at
/// the composition root, same pattern as [HubDiscovery]/[HubTransport].
abstract class DeviceIdentityStore {
  /// Returns the existing identity, or null if this device has never been
  /// enrolled.
  Future<DeviceIdentity?> load();

  /// Generates a new identity and persists it. Must be idempotent-safe to
  /// call only once per device lifetime in a real implementation (a real
  /// store should refuse to silently regenerate over an existing identity —
  /// that would look like a cloned/reset panel to the Hub).
  Future<DeviceIdentity> generateAndPersist();
}

/// Deterministic in-memory stand-in for tests (§Phase9-19) and for
/// composing the app before platform secure storage exists. NOT persisted
/// across process restarts — a real store's entire point is durability
/// across reboot/DHCP change, which this intentionally does not provide.
class InMemoryDeviceIdentityStore implements DeviceIdentityStore {
  DeviceIdentity? _identity;
  final String Function()? idGenerator;

  InMemoryDeviceIdentityStore({this.idGenerator});

  @override
  Future<DeviceIdentity?> load() async => _identity;

  @override
  Future<DeviceIdentity> generateAndPersist() async {
    final id = idGenerator?.call() ??
        'device-${DateTime.now().microsecondsSinceEpoch}';
    final identity = DeviceIdentity(deviceId: id, publicCredential: 'pub:$id');
    _identity = identity;
    return identity;
  }
}
