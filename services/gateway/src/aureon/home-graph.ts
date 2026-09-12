import type { AssistantContext } from "@supreme/ai";
import type { Device, Room } from "@supreme/domain-model";
import type { HomeService } from "@supreme/home";

/**
 * Aureon Home Graph, MVP slice (§ AUREON-ARCHITECTURE.md §2.2, §3.3).
 *
 * This is deliberately NOT a second device database: every query here reads live
 * `Room`/`Device` rows through the existing `HomeService` and derives an answer —
 * nothing is cached or persisted separately. If SupremeOS's room/device data
 * disagrees with anything computed below, SupremeOS's data is what's returned next
 * call; there is no independent state to drift.
 *
 * `function_zone` semantic grouping (living-room "ambient lighting" as a named
 * cross-protocol concept) from the full architecture doc is NOT implemented here —
 * flagged as a later increment once this structural layer is proven. Only the
 * structural relationships (room→devices, capability search) ship in this pass.
 */
export class AureonHomeGraph {
  constructor(private readonly home: HomeService) {}

  async rooms(): Promise<Room[]> {
    return this.home.listRooms();
  }

  async devices(): Promise<Device[]> {
    return this.home.listDevices();
  }

  /** Resolve a room by exact or partial (case-insensitive) name match. */
  async findRoom(nameFragment: string): Promise<Room | null> {
    const needle = nameFragment.trim().toLowerCase();
    if (!needle) return null;
    const rooms = await this.rooms();
    return (
      rooms.find((r) => r.name.toLowerCase() === needle) ??
      rooms.find((r) => r.name.toLowerCase().includes(needle)) ??
      null
    );
  }

  async devicesInRoom(roomId: string): Promise<Device[]> {
    const devices = await this.devices();
    return devices.filter((d) => d.roomId === roomId);
  }

  /** Devices anywhere in the home that declare a given capability kind. */
  async devicesWithCapability(capability: string, roomId?: string | null): Promise<Device[]> {
    const devices = roomId ? await this.devicesInRoom(roomId) : await this.devices();
    return devices.filter((d) => d.capabilities.some((c) => c.kind === capability));
  }

  /**
   * Build the flat {@link AssistantContext} shape the existing `@supreme/ai` planner
   * consumes. Factored out of `phase3.ts`'s `/v1/ai/assistant` route so both the
   * legacy endpoint and the new Aureon endpoints build context identically — pure
   * extraction, no behavior change to the existing route.
   */
  async assistantContext(): Promise<AssistantContext> {
    const [rooms, devices] = await Promise.all([this.rooms(), this.devices()]);
    return {
      rooms: rooms.map((r) => ({ id: r.id, name: r.name })),
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        roomId: d.roomId,
        supremeType: d.supremeType,
        capabilities: d.capabilities.map((c) => c.kind),
      })),
    };
  }
}
