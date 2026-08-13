import {
  BulkDeviceRequest,
  CommandRequest,
  DeviceRawCommandRequest,
  SupremeError,
  UpdateDeviceRequest,
  type CommandResponse,
  type DeviceCapabilitiesRefreshResponse,
  type DeviceDiagnosticsResponse,
  type DeviceResponse,
  type DeviceTraceResponse,
  type MediaQueueResponse,
} from "@supreme/contracts";
import type { DeviceId, RoomId } from "@supreme/domain-model";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, enforce } from "../auth.js";
import { ArtworkCache } from "../artwork-cache.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

// § Pass 12.6, Part E/H — same length bound `UpdateDeviceRequest.name` already uses
// (rest.ts), for consistency across every homeowner-facing rename surface. Empty names are
// rejected here too, matching how the device-rename endpoint itself behaves (no
// "clear to fallback" via PATCH) — clearing a custom input name is a separate DELETE.
const SetAvrInputNameRequest = z.object({ name: z.string().min(1).max(120) });

/** Order-independent deep-equality check for two capability-config objects, via a
 * key-sorted JSON.stringify (§ Capability Refresh). Plain `JSON.stringify(a) ===
 * JSON.stringify(b)` — used elsewhere in this codebase for capability-STATE dedup
 * (`av-sdk/state-cache.ts`), where both sides always come from the same driver code
 * path so key order is stable — is NOT safe here: one side is a driver's freshly
 * re-computed object literal, the other has round-tripped through storage, and
 * nothing guarantees identical key insertion order between them even when every
 * value is identical. A false "changed" would misreport "Capabilities refreshed"
 * for a protocol (e.g. Denon/Marantz Telnet) that returns byte-for-byte the same
 * deterministic config every time. */
function sameCapabilityConfig(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The core control verb (§6): POST /v1/devices/:id/command. */
export function registerDeviceRoutes(app: FastifyInstance, ctx: AppContext): void {
  const artworkCache = new ArtworkCache();
  app.post<{ Params: { id: string } }>("/v1/devices/:id/command", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");

      await enforce(ctx, user, "device", deviceId, "control");

      const { command } = CommandRequest.parse(req.body);
      const source = `Device: ${device.name}`;
      try {
        await ctx.sil.command(deviceId, command);
      } catch (err) {
        // A native driver command that never reached the device (not connected, wire error,
        // unsupported for this unit, …) must be visible — the Settings → Logs page is the
        // one place to see "did my command actually work" across every device/protocol.
        ctx.installer.logEvent(source, "error", `${command.capability} command failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      ctx.installer.logEvent(source, "info", `${command.capability} command sent`);
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.command",
        resourceType: "device",
        resourceId: deviceId,
        metadata: { capability: command.capability },
      });
      const body: CommandResponse = {
        accepted: true,
        device: (await ctx.home.getDevice(deviceId)) ?? undefined,
      };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Move and/or rename a device (§4): PATCH /v1/devices/:id. Any device can be reassigned to
  // any existing room. Owner/admin/installer only (device:update).
  app.patch<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "update");

      const patch = UpdateDeviceRequest.parse(req.body);
      const device = await ctx.home.updateDevice(deviceId, {
        name: patch.name,
        roomId: patch.roomId as RoomId | undefined,
        metadata: patch.metadata,
      });
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.update",
        resourceType: "device",
        resourceId: deviceId,
        metadata: { name: patch.name, roomId: patch.roomId, metadataKeys: patch.metadata ? Object.keys(patch.metadata) : undefined },
      });
      reply.send({ device } satisfies DeviceResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Delete a device (§4): DELETE /v1/devices/:id. Drops its backend bindings too.
  // Owner/admin/installer only (device:delete).
  app.delete<{ Params: { id: string } }>("/v1/devices/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "delete");

      await ctx.home.removeDevice(deviceId);
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "device.delete",
        resourceType: "device",
        resourceId: deviceId,
      });
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Clone a device's configuration into a new device (§ Device Platform). device:create.
  app.post<{ Params: { id: string } }>("/v1/devices/:id/clone", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      if (!(await ctx.home.getDevice(deviceId))) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", null, "create");
      const device = await ctx.home.cloneDevice(deviceId);
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.clone", resourceType: "device", resourceId: device.id, metadata: { from: deviceId } });
      reply.code(201).send({ device } satisfies DeviceResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Bulk operations over a device selection (§ Device Platform): move to a room, or remove.
  app.post("/v1/devices/bulk", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const body = BulkDeviceRequest.parse(req.body);
      const ids = body.ids as DeviceId[];
      if (body.action === "move") {
        if (!body.roomId) throw new SupremeError("validation_failed", "roomId is required to move");
        await enforce(ctx, user, "device", null, "update");
        const moved = await ctx.home.moveDevices(ids, body.roomId as RoomId);
        await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.bulk_move", resourceType: "device", resourceId: null, metadata: { count: moved, roomId: body.roomId } });
        reply.send({ affected: moved });
      } else {
        await enforce(ctx, user, "device", null, "delete");
        const removed = await ctx.home.removeDevices(ids);
        await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "device.bulk_remove", resourceType: "device", resourceId: null, metadata: { count: removed } });
        reply.send({ affected: removed });
      }
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Cover art proxy (§11 media): streams a media device's current artwork bytes from
  // the backend (e.g. the Apple TV bridge, or a Yamaha unit's device-local album-art
  // path) so clients render it without reaching any internal service. The media
  // state's `artworkUrl` points here. Fronted by an in-process cache (artwork-cache.ts)
  // so now-playing polling doesn't re-fetch the same bytes on every refresh.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/media/artwork", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const art = await artworkCache.get(deviceId, () => ctx.sil.getArtwork(deviceId));
      if (!art) throw new SupremeError("not_found", "no artwork");
      reply.header("content-type", art.contentType);
      reply.header("cache-control", "private, max-age=60");
      reply.send(Buffer.from(art.data));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Play-queue pull (§ Universal AVR Framework — media integration): GET
  // /v1/devices/:id/media/queue. Only meaningful for protocols with a real queue
  // concept on the wire (HEOS today); other media devices return an empty list rather
  // than a fabricated one — the response shape stays uniform either way.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/media/queue", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const items = (await ctx.sil.getQueue(deviceId)) ?? [];
      reply.send({ items } satisfies MediaQueueResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Diagnostics Console (§ Universal AV Driver SDK): GET /v1/devices/:id/diagnostics —
  // real connection/traffic diagnostics (RX/TX counts, last command/response, response
  // time, reconnect count, last error) from the device's owning driver. `null` when
  // unsupported (HA-backed device, or a protocol with no diagnostics tracker) rather
  // than a fabricated all-zero shape. Same "device"/"view" permission as artwork/queue
  // — this is only ever rendered behind the client's own devMode gate.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const diagnostics = await ctx.sil.getDiagnostics(deviceId);
      reply.send({ diagnostics } satisfies DeviceDiagnosticsResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Universal AVR SDK: GET /v1/devices/:id/diagnostics/trace — the device's owning
  // driver's recent raw protocol trace (every real send/receive line, automatically
  // captured — see `DriverDiagnosticsTracker.recordTrace`). `null` when unsupported.
  // Same permission posture as `/diagnostics` — devMode-gated on the client.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/diagnostics/trace", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const trace = await ctx.sil.getTrace(deviceId);
      reply.send({ trace } satisfies DeviceTraceResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § AVR Diagnostic Mode: GET /v1/devices/:id/diagnostics/export — the device's owning
  // driver's complete diagnostic trace log (every captured event, under its correlation
  // ID, ending with the session summary — see `AvrDiagnosticsRecorder.exportLog`). `null`
  // when unsupported, or diagnostics isn't enabled for that driver instance (see
  // `SUPREME_AVR_DIAGNOSTICS`, off by default). Served as a downloadable `diagnostic.log`
  // file (not JSON) so this route IS "the single command that exports diagnostic.log" —
  // e.g. `curl -H "Authorization: Bearer $TOKEN" .../diagnostics/export -o diagnostic.log`.
  // Same permission posture as `/diagnostics`/`/diagnostics/trace` — devMode-gated on the
  // client, but this is a read, so `view` (not `control`) is the correct permission.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/diagnostics/export", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const log = await ctx.sil.exportDiagnosticsLog(deviceId);
      if (log === null) throw new SupremeError("not_found", "diagnostics not enabled for this device's driver");
      reply.header("content-type", "text/plain; charset=utf-8");
      reply.header("content-disposition", "attachment; filename=\"diagnostic.log\"");
      reply.send(log);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § RTI Capability Audit, Category C.4: POST /v1/devices/:id/raw-command — devMode-only
  // raw-token escape hatch. Writes `token` verbatim to the device's owning driver,
  // bypassing the typed CapabilityCommand dispatch entirely. `control` permission (same as
  // the typed /command route) since this is a real write, not a read — but this route
  // exists at all only for a driver that opted in via `sendRaw` (validation_failed
  // otherwise), and is only ever surfaced behind the client's own devMode gate, same
  // posture as /diagnostics/trace.
  app.post<{ Params: { id: string }; Body: unknown }>("/v1/devices/:id/raw-command", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "control");
      const body = DeviceRawCommandRequest.parse(req.body);
      await ctx.sil.sendRaw(deviceId, body.token);
      reply.send({ ok: true });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Capability Refresh (§ Part 2): POST /v1/devices/:id/capabilities/refresh —
  // re-query the owning driver's real capabilities in place and persist whatever it
  // reports. Never recreates the device (only `home.setCapabilityConfig` is touched,
  // the same call `bindProtocol()` already makes at first-commission time), so room
  // assignment/automations/history are all untouched. `refreshed` means the config
  // GENUINELY CHANGED, not merely "a config was returned" — a protocol with no live
  // capability query (e.g. Denon/Marantz Telnet) returns the exact same deterministic
  // config every time, so `refreshed: false` there is the honest, expected outcome
  // (a real reconnect happened, nothing new was discoverable), not an error.
  app.post<{ Params: { id: string } }>("/v1/devices/:id/capabilities/refresh", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "control");
      await ctx.sil.refreshCapabilities(deviceId);
      let refreshedConfig: Record<string, unknown> | null = null;
      let changed = false;
      let updatedDevice = device;
      for (const cap of device.capabilities) {
        const config = await ctx.sil.getCapabilityConfig(deviceId, cap.kind);
        if (config) {
          if (!sameCapabilityConfig(config, cap.config)) changed = true;
          const saved = await ctx.home.setCapabilityConfig(deviceId, cap.kind, config);
          if (saved) updatedDevice = saved;
          if (cap.kind === "media") refreshedConfig = config;
        }
      }
      reply.send({
        refreshed: changed,
        config: refreshedConfig,
        device: updatedDevice,
      } satisfies DeviceCapabilitiesRefreshResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Pass 12.6, Part E — GET /v1/devices/:id/avr/inputs: this AVR's real input list
  // (technicalId/reportedName/customName/displayName), for the future input-rename UI. Same
  // "view" permission as /diagnostics — a read, not a write.
  app.get<{ Params: { id: string } }>("/v1/devices/:id/avr/inputs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      const deviceId = req.params.id as DeviceId;
      const device = await ctx.home.getDevice(deviceId);
      if (!device) throw new SupremeError("not_found", "device not found");
      await enforce(ctx, user, "device", deviceId, "view");
      const inputs = await ctx.sil.getAvrInputs(deviceId);
      if (inputs === null) throw new SupremeError("not_found", "this device has no AVR input list to report");
      reply.send({ inputs });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Pass 12.6, Part E — PATCH /v1/devices/:id/avr/inputs/:technicalId: set the
  // homeowner-facing custom label for one AVR input, keyed by the stable wire `SI` token
  // (never a display name). Same "update" permission as PATCH /v1/devices/:id (device rename).
  // Persists by re-running `bindProtocol()` with the merged config — the same
  // bind-then-persist-then-refresh-capability-config path first commissioning already uses
  // (§ installer-context.ts `bindProtocol`), no new persistence subsystem.
  app.patch<{ Params: { id: string; technicalId: string }; Body: unknown }>(
    "/v1/devices/:id/avr/inputs/:technicalId",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        const deviceId = req.params.id as DeviceId;
        const technicalId = req.params.technicalId;
        const device = await ctx.home.getDevice(deviceId);
        if (!device) throw new SupremeError("not_found", "device not found");
        await enforce(ctx, user, "device", deviceId, "update");
        const { name } = SetAvrInputNameRequest.parse(req.body);
        const device2 = await setAvrInputName(ctx, deviceId, technicalId, name);
        reply.send({ device: device2, inputs: await ctx.sil.getAvrInputs(deviceId) });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // § Pass 12.6, Part E — DELETE /v1/devices/:id/avr/inputs/:technicalId: clear a custom
  // label, falling back to the AVR-reported/spec-derived name (mirrors what an empty PATCH
  // body would mean, but PATCH itself rejects empty names for consistency with
  // UpdateDeviceRequest.name — see SetAvrInputNameRequest above).
  app.delete<{ Params: { id: string; technicalId: string } }>(
    "/v1/devices/:id/avr/inputs/:technicalId",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        const deviceId = req.params.id as DeviceId;
        const technicalId = req.params.technicalId;
        const device = await ctx.home.getDevice(deviceId);
        if (!device) throw new SupremeError("not_found", "device not found");
        await enforce(ctx, user, "device", deviceId, "update");
        const device2 = await setAvrInputName(ctx, deviceId, technicalId, null);
        reply.send({ device: device2, inputs: await ctx.sil.getAvrInputs(deviceId) });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );
}

/** § Pass 12.6, Part E — shared by the PATCH/DELETE input-name routes: apply the change to
 * the live driver, then re-persist `ProtocolBinding.config` via the same `bindProtocol()`
 * commissioning already uses so it survives a restart/rediscovery. Throws `validation_failed`
 * for an unknown `technicalId` — the driver itself is the source of truth for which wire
 * tokens are real, never a client-supplied string. */
async function setAvrInputName(ctx: AppContext, deviceId: DeviceId, technicalId: string, name: string | null): Promise<DeviceResponse["device"]> {
  const applied = await ctx.sil.setAvrInputCustomName(deviceId, technicalId, name);
  if (!applied) throw new SupremeError("validation_failed", `"${technicalId}" is not a valid input on this device`);
  const bindings = await ctx.installer.listProtocolBindings();
  const binding = bindings.find((b) => b.deviceId === deviceId && b.capability === "media");
  if (binding) {
    const customInputNames = { ...(binding.config?.customInputNames as Record<string, string> | undefined) };
    if (name === null) delete customInputNames[technicalId];
    else customInputNames[technicalId] = name;
    await ctx.installer.bindProtocol({
      deviceId,
      capability: binding.capability,
      protocol: binding.protocol,
      address: binding.address,
      config: { ...binding.config, customInputNames },
    });
  }
  return (await ctx.home.getDevice(deviceId)) as DeviceResponse["device"];
}
