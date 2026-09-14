import 'package:supreme_os_core/supreme_os_core.dart';

/// Web has no UDP multicast socket API `package:multicast_dns` can use — real mDNS discovery
/// is structurally impossible in a browser sandbox, not a gap in this codebase (§Phase9 already
/// documented this exact `dart:io` incompatibility as why `MdnsHubDiscovery` is excluded from
/// the main barrel). Falling back to an empty, deterministic `MockHubDiscovery` here means a
/// web build stays honest — it simply never finds a Hub — rather than crashing on an
/// unavailable platform API.
HubDiscovery buildPlatformDiscovery() =>
    const MockHubDiscovery(hubPresent: false);
