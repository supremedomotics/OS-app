import 'package:aureon_flutter/aureon_flutter.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:supreme_sdk/supreme_sdk.dart';

import '../providers.dart';
import '../room_categories.dart';
import '../room_image.dart';
import 'category_device_list_screen.dart';
import 'room_lighting_screen.dart';

/// Room navigation (§11.1), step one: Room → category cards. Reached by tapping a room from the
/// pager; shows a card per control type actually present in the room (Lighting, Media, Curtains,
/// Climate, …) with a live one-line summary. The SAME screen is used at every width — phone or
/// tablet — the category screen itself doesn't need a different layout to feel right at either size.
class RoomCategoriesScreen extends ConsumerStatefulWidget {
  const RoomCategoriesScreen({super.key, required this.roomId, required this.roomName, this.areaType, this.heroImageUrl});

  final String roomId;
  final String roomName;
  final String? areaType;
  final String? heroImageUrl;

  @override
  ConsumerState<RoomCategoriesScreen> createState() => _RoomCategoriesScreenState();
}

class _RoomCategoriesScreenState extends ConsumerState<RoomCategoriesScreen> {
  List<Device> _devices = [];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
    ensureRoomHero(ref.read(clientProvider), widget.roomId, widget.heroImageUrl).then((pinned) {
      if (pinned && mounted) ref.invalidate(homeProvider);
    });
  }

  Future<void> _load() async {
    final devices = await ref.read(clientProvider).devicesInRoom(widget.roomId);
    if (!mounted) return;
    setState(() {
      _devices = devices;
      _loading = false;
    });
  }

  Future<void> _open(Category c) async {
    if (c.def.kind == CategoryKind.lighting) {
      await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => RoomLightingScreen(roomName: widget.roomName, lights: c.devices)));
    } else {
      await Navigator.of(context).push(MaterialPageRoute<void>(
          builder: (_) => CategoryDeviceListScreen(roomName: widget.roomName, category: c)));
    }
    _load();
  }

  @override
  Widget build(BuildContext context) {
    final live = ref.watch(liveStatesProvider);
    final cats = categorize(_devices);
    // No Scaffold here — this is one page of HomePager's PageView, which already provides one.
    return SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AureonSpacing.lg),
          children: [
            Builder(builder: (_) {
              final st = roomStyle(widget.roomName, widget.areaType);
              final photo = ref.watch(roomPhotoProvider((name: widget.roomName, areaType: widget.areaType, heroImageUrl: widget.heroImageUrl))).valueOrNull;
              return RoomHero(
                title: widget.roomName,
                imageUrl: photo,
                gradientColors: [st.from, st.to],
                motif: st.emoji,
                statusValue: '${_devices.length}',
                statusLabel: _devices.length == 1 ? 'device' : 'devices',
                height: 200,
              );
            }),
            const SizedBox(height: AureonSpacing.lg),
            if (_loading)
              const Center(child: Padding(padding: EdgeInsets.all(40), child: CircularProgressIndicator()))
            else
              for (final c in cats)
                Padding(
                  padding: const EdgeInsets.only(bottom: AureonSpacing.md),
                  child: CategoryTile(
                    icon: c.def.icon,
                    label: c.def.label,
                    value: categorySummary(c.def.kind, c.devices, live),
                    onTap: () => _open(c),
                    trailing: const Icon(Icons.chevron_right, size: 20),
                  ),
                ),
          ],
        ),
    );
  }
}
