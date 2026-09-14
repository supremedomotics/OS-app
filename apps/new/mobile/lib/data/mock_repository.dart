import 'package:supreme_os_core/supreme_os_core.dart';

/// Demo repository standing in for the future gateway client (§43). Every
/// screen depends on this interface, never on hardcoded data directly.
abstract class HomeRepository {
  Future<List<Space>> spaces();
  Future<List<Experience>> experiences();
}

class MockHomeRepository implements HomeRepository {
  @override
  Future<List<Space>> spaces() async => const [
        Space(
            id: 'living-room',
            name: 'Living Room',
            floorId: 'ground',
            domains: {
              HomeDomain.lighting,
              HomeDomain.shades,
              HomeDomain.climate,
              HomeDomain.audio,
            }),
        Space(id: 'dining', name: 'Dining', floorId: 'ground', domains: {
          HomeDomain.lighting,
          HomeDomain.climate,
        }),
        Space(id: 'kitchen', name: 'Kitchen', floorId: 'ground', domains: {
          HomeDomain.lighting,
          HomeDomain.climate,
        }),
        Space(
            id: 'master-bedroom',
            name: 'Master Bedroom',
            floorId: 'first',
            domains: {
              HomeDomain.lighting,
              HomeDomain.shades,
              HomeDomain.climate,
              HomeDomain.audio,
            }),
        Space(id: 'terrace', name: 'Terrace', floorId: 'ground', domains: {
          HomeDomain.lighting,
          HomeDomain.audio,
        }),
      ];

  @override
  Future<List<Experience>> experiences() async => const [
        Experience(
            id: 'relax', name: 'Relax', spaceIds: ['living-room', 'terrace']),
        Experience(
            id: 'entertain',
            name: 'Entertain',
            spaceIds: ['living-room', 'dining', 'terrace']),
        Experience(
            id: 'good-night', name: 'Good Night', spaceIds: ['master-bedroom']),
        Experience(id: 'away', name: 'Away', spaceIds: []),
      ];
}
