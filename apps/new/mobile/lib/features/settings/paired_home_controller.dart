import 'package:flutter/foundation.dart';
import 'package:supreme_os_core/supreme_os_core.dart';

/// Thin `ChangeNotifier` wrapper around the pure-Dart `PairedHomeManager` (§Phase12.1) so
/// Mobile/Tablet widgets can rebuild on Home list/active-Home changes. All real logic
/// (persistence, validation, isolation) lives in `PairedHomeManager` itself — this class adds
/// nothing but Flutter's observer pattern on top, so Tablet reuses it unchanged (§18).
class PairedHomeController extends ChangeNotifier {
  final PairedHomeManager _manager;
  bool _loaded = false;

  PairedHomeController(PairedHomeStore store)
      : _manager = PairedHomeManager(store);

  bool get isLoaded => _loaded;
  List<PairedHome> get homes => _manager.homes;
  String? get activeHomeId => _manager.activeHomeId;
  PairedHome? get activeHome => _manager.activeHome;

  Future<void> load() async {
    await _manager.load();
    _loaded = true;
    notifyListeners();
  }

  Future<PairedHome> addHome(
      {required String hubId,
      required String projectId,
      required String displayName}) async {
    final home = await _manager.addHome(
        hubId: hubId, projectId: projectId, displayName: displayName);
    notifyListeners();
    return home;
  }

  Future<void> renameHome(String hubId, String newDisplayName) async {
    await _manager.renameHome(hubId, newDisplayName);
    notifyListeners();
  }

  Future<void> removeHome(String hubId) async {
    await _manager.removeHome(hubId);
    notifyListeners();
  }

  Future<void> setActiveHome(String hubId) async {
    await _manager.setActiveHome(hubId);
    notifyListeners();
  }

  Future<void> setRemoteAccessEnabled(String hubId, bool enabled) async {
    await _manager.setRemoteAccessEnabled(hubId, enabled);
    notifyListeners();
  }
}
