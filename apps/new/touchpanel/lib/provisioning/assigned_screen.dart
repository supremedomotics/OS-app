import 'package:flutter/material.dart';
import 'package:supreme_os_ui/supreme_os_ui.dart';

import '../experience/room_experience_screen.dart';
import '../residence/panel_residence.dart';

/// The panel's normal, locked UI (§7, §Phase8-1). CRITICAL: never exposes
/// "Change Room" / "Change Assignment" / "Reassign Panel" (§19) —
/// reassignment only ever arrives pushed from the Hub (§41), never
/// initiated from this screen. Navigation depends on scope (§Phase8-18):
/// ROOM shows its one room with no navigation at all; FLOOR/WHOLE HOME show
/// a room switcher scoped to exactly the assigned floor or the whole
/// project — never a control to change the assignment itself.
class AssignedScreen extends StatefulWidget {
  final PanelConfig config;
  final Future<List<AreaSummary>> Function() fetchAreas;
  final ConnectionManager connection;

  /// The panel's residence. When present it is the truth about the Hub link and about every
  /// control; [connection] is then only the legacy link indicator source for a panel without one.
  final PanelResidence? residence;

  const AssignedScreen({
    super.key,
    required this.config,
    required this.fetchAreas,
    required this.connection,
    this.residence,
  });

  @override
  State<AssignedScreen> createState() => _AssignedScreenState();
}

class _AssignedScreenState extends State<AssignedScreen> {
  List<AreaSummary>? _scopedAreas;
  String? _selectedAreaId;

  PanelAssignment get _assignment => widget.config.assignment!;

  @override
  void initState() {
    super.initState();
    if (_assignment.scope != ControlScope.room) {
      _loadScopedAreas();
    }
  }

  Future<void> _loadScopedAreas() async {
    final all = await widget.fetchAreas();
    final scoped = _assignment.scope == ControlScope.floor
        ? all.where((a) => a.floorId == _assignment.assignedAreaId).toList()
        : all; // wholeHome: every space in the project
    setState(() {
      _scopedAreas = scoped;
      _selectedAreaId = scoped.isNotEmpty ? scoped.first.id : null;
    });
  }

  @override
  Widget build(BuildContext context) {
    return PanelResidenceScope(
      residence: widget.residence,
      child: Scaffold(
      backgroundColor: SupremeColorScheme.voidBg,
      body: SafeArea(
        child: StreamBuilder<HubConnectionState>(
          stream: widget.connection.state,
          initialData: widget.connection.current,
          builder: (context, snap) => PanelResidenceBuilder(builder: (context, residence) {
            // With a residence, the Hub link IS the residence's reachability; the mock
            // connection manager says nothing true about it.
            final connected =
                residence != null ? residence.connected : (snap.data?.isConnected ?? false);
            final status = residence != null
                ? (connected ? ConnectionStatus.connectedLocal : ConnectionStatus.offline)
                : (snap.data?.status ?? ConnectionStatus.offline);
            return switch (_assignment.scope) {
              ControlScope.room => RoomExperienceScreen(
                  roomName: _assignment.displayName,
                  spaceId: _assignment.assignedRoomId ?? '',
                  connected: connected,
                  headerTrailing: ConnectionStateIndicator(status: status),
                ),
              ControlScope.floor ||
              ControlScope.wholeHome =>
                _ScopedRoomSwitcher(
                  areas: _scopedAreas,
                  selectedAreaId: _selectedAreaId,
                  onSelect: (id) => setState(() => _selectedAreaId = id),
                  connected: connected,
                  status: status,
                ),
            };
          }),
        ),
      ),
    ));
  }
}

/// Room navigation for FLOOR/WHOLE HOME scope (§Phase8-18) — movement among
/// the panel's OWN scoped spaces only. This is not a generic room picker:
/// the list is pre-filtered to the assignment's scope before this widget
/// ever sees it, so it structurally cannot navigate outside that scope.
class _ScopedRoomSwitcher extends StatelessWidget {
  final List<AreaSummary>? areas;
  final String? selectedAreaId;
  final ValueChanged<String> onSelect;
  final bool connected;
  final ConnectionStatus status;

  const _ScopedRoomSwitcher({
    required this.areas,
    required this.selectedAreaId,
    required this.onSelect,
    required this.connected,
    required this.status,
  });

  @override
  Widget build(BuildContext context) {
    final profile = AdaptiveScope.of(context);
    final spacing = profile.spacing;

    if (areas == null) {
      return const Center(
          child: CircularProgressIndicator(color: SupremeColorScheme.gold500));
    }

    AreaSummary? selected;
    for (final area in areas!) {
      if (area.id == selectedAreaId) {
        selected = area;
        break;
      }
    }

    return Column(
      children: [
        Padding(
          padding: EdgeInsets.symmetric(
            horizontal: spacing.space(SupremeSpaceToken.md),
            vertical: spacing.space(SupremeSpaceToken.sm),
          ),
          child: Row(children: [
            Expanded(
              child: SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [
                  for (final area in areas!)
                    Padding(
                      padding: EdgeInsets.only(
                          right: spacing.space(SupremeSpaceToken.sm)),
                      child: ChoiceChip(
                        label: Text(area.name),
                        selected: area.id == selectedAreaId,
                        onSelected: (_) => onSelect(area.id),
                      ),
                    ),
                ]),
              ),
            ),
            ConnectionStateIndicator(status: status),
          ]),
        ),
        Expanded(
          child: selected == null
              ? const SizedBox.shrink()
              : RoomExperienceScreen(
                  roomName: selected.name, spaceId: selected.id, connected: connected),
        ),
      ],
    );
  }
}
