// ignore: implementation_imports
import 'package:supreme_os_core/src/connection/mdns_hub_discovery.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Real platform (Android/iOS/desktop) — genuine mDNS/DNS-SD discovery for
/// `_supremeos._tcp` (§Phase12.3: "wire the existing real MdnsHubDiscovery into the Mobile
/// composition root"). `MdnsHubDiscovery` itself is unchanged, real, Phase 9 code — this file
/// only supplies the platform-conditional import site that lets `discovery_factory.dart`
/// select it on `dart:io` platforms while staying web-safe (see `discovery_factory_web.dart`).
///
/// HONEST STATUS: REAL/IMPLEMENTED as a discovery client — genuinely browses mDNS and parses
/// PTR/SRV/TXT records into `DiscoveredHub`. REAL-WORLD TEST REQUIRED: has not been run
/// against an actual Hub advertising `_supremeos._tcp` on a real network from this composition
/// root (same caveat Phase 9 already recorded for `MdnsHubDiscovery` itself).
HubDiscovery buildPlatformDiscovery() => const MdnsHubDiscovery();
