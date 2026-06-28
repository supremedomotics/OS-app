import type { HomeView } from "@supreme/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { AppContext } from "./context.js";
import { buildServer } from "./server.js";

/**
 * Device management (§4): any device can be moved to any room, renamed, or deleted — through
 * the full stack, owner/admin/installer only. Homeowners/family have control but not management.
 */
describe("Device management — move / rename / delete", () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let baseUrl: string;

  beforeAll(async () => {
    ctx = await AppContext.create(loadConfig({ SUPREME_PORT: "0", SUPREME_LOG_LEVEL: "silent" }));
    app = await buildServer(ctx);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const addr = app.server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  afterAll(async () => {
    await app.close();
    await ctx.shutdown();
  });

  async function login(email = "owner@supreme.local", password = "supreme-owner-demo-pass") {
    const res = await fetch(`${baseUrl}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    return ((await res.json()) as { accessToken: string }).accessToken;
  }
  const auth = (t: string) => ({ authorization: `Bearer ${t}`, "content-type": "application/json" });
  const home = async (t: string) => (await (await fetch(`${baseUrl}/v1/home`, { headers: auth(t) })).json()) as HomeView;
  const roomDevices = async (t: string, roomId: string) =>
    ((await (await fetch(`${baseUrl}/v1/rooms/${roomId}/devices`, { headers: auth(t) })).json()) as {
      devices: { id: string; name: string }[];
    }).devices;

  it("moves any device to any room and renames it (owner)", async () => {
    const token = await login();
    const h = await home(token);
    const living = h.rooms.find((r) => r.name === "Living Room")!;
    const bedroom = h.rooms.find((r) => r.name === "Bedroom")!;
    const device = (await roomDevices(token, living.id))[0]!;

    const res = await fetch(`${baseUrl}/v1/devices/${device.id}`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ roomId: bedroom.id, name: "Reading Lamp" }),
    });
    expect(res.status).toBe(200);
    const { device: moved } = (await res.json()) as { device: { roomId: string; name: string } };
    expect(moved.roomId).toBe(bedroom.id);
    expect(moved.name).toBe("Reading Lamp");

    // It now appears in the Bedroom, not the Living Room.
    expect((await roomDevices(token, bedroom.id)).some((d) => d.id === device.id)).toBe(true);
    expect((await roomDevices(token, living.id)).some((d) => d.id === device.id)).toBe(false);
  });

  it("rejects a move to a non-existent room (404)", async () => {
    const token = await login();
    const h = await home(token);
    const device = (await roomDevices(token, h.rooms[0]!.id))[0]!;
    const res = await fetch(`${baseUrl}/v1/devices/${device.id}`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({ roomId: "room-does-not-exist" }),
    });
    expect(res.status).toBe(404);
  });

  it("denies management to a family member (403), but they can still control", async () => {
    const owner = await login();
    // Master provisions a family member (control, not management).
    await fetch(`${baseUrl}/v1/users`, {
      method: "POST",
      headers: auth(owner),
      body: JSON.stringify({
        email: "family-dm@supreme.local",
        password: "family-demo-password",
        displayName: "Family Member",
        userType: "family",
      }),
    });
    const family = await login("family-dm@supreme.local", "family-demo-password");
    const h = await home(owner);
    const device = (await roomDevices(owner, h.rooms[0]!.id))[0]!;

    // Family cannot move/rename/delete…
    const patch = await fetch(`${baseUrl}/v1/devices/${device.id}`, {
      method: "PATCH",
      headers: auth(family),
      body: JSON.stringify({ name: "Nope" }),
    });
    expect(patch.status).toBe(403);
    const del = await fetch(`${baseUrl}/v1/devices/${device.id}`, { method: "DELETE", headers: auth(family) });
    expect(del.status).toBe(403);

    // …but they CAN still control it.
    const cmd = await fetch(`${baseUrl}/v1/devices/${device.id}/command`, {
      method: "POST",
      headers: auth(family),
      body: JSON.stringify({ command: { capability: "onoff", action: "on" } }),
    });
    expect(cmd.status).toBe(200);
  });

  it("deletes a device (owner) and it disappears from its room", async () => {
    const token = await login();
    const h = await home(token);
    const room = h.rooms.find((r) => r.name === "Kitchen") ?? h.rooms[0]!;
    const device = (await roomDevices(token, room.id))[0];
    if (!device) return; // no device to delete in this room
    const res = await fetch(`${baseUrl}/v1/devices/${device.id}`, { method: "DELETE", headers: auth(token) });
    expect(res.status).toBe(204);
    expect((await roomDevices(token, room.id)).some((d) => d.id === device.id)).toBe(false);
  });

  it("rejects a PATCH with no fields (422)", async () => {
    const token = await login();
    const h = await home(token);
    const device = (await roomDevices(token, h.rooms[0]!.id))[0]!;
    const res = await fetch(`${baseUrl}/v1/devices/${device.id}`, {
      method: "PATCH",
      headers: auth(token),
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });
});
