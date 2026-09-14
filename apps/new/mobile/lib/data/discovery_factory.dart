import 'package:supreme_os_core/supreme_os_core.dart';

export 'discovery_factory_web.dart'
    if (dart.library.io) 'discovery_factory_io.dart';

/// Platform-conditional real discovery (§Phase12.3 "mDNS" — "wire the existing real
/// MdnsHubDiscovery into the Mobile composition root ... The production composition root
/// must no longer rely on MockHubDiscovery"). The actual factory function
/// (`buildPlatformDiscovery`) is provided by whichever of `discovery_factory_io.dart`
/// (real `MdnsHubDiscovery`) or `discovery_factory_web.dart` (web has no UDP multicast
/// socket API — an honest, documented fallback, not a silent gap) the `export` above
/// selects at compile time. `MockHubDiscovery` itself is untouched and still used directly
/// by tests (§Phase12.3: "Do not delete MockHubDiscovery. Mocks remain useful for
/// deterministic tests.").
typedef PlatformDiscoveryFactory = HubDiscovery Function();
