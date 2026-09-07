import { SupremeError } from "@supreme/contracts";
import type { RoomId } from "@supreme/domain-model";
import { MatterPairingError } from "@supreme/protocols";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

const CommissionMatterRequest = z.object({
  /** Manual pairing code (11/21 digits) or an `MT:` QR payload from the device label. */
  setupCode: z.string().min(1),
  roomId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
});

/**
 * Matter routes (§9): opt-in status + setup-code commissioning. Matter ships disabled; when enabled
 * AND its on-box controller is running, an installer can pair a new device by its setup code (PASE)
 * and the joined node is registered as a Supreme device + bound to the Matter protocol. Discovery of
 * already-commissioned nodes flows through the generic /v1/commissioning/discover.
 */
export function registerMatterRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Status: is Matter enabled, is the controller connected, and the fabric/node summary.
  app.get("/v1/matter/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const driver = ctx.matter?.driver;
      const connected = driver?.isConnected() ?? false;
      const nodeCount = connected ? (await driver!.discover()).length : 0;
      reply.send({
        enabled: ctx.matter !== null,
        connected,
        fabricId: ctx.matter?.fabric?.currentFabricId ?? null,
        nodeCount,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // HomeKit (Apple Home / Siri) bridge status. The bridge is local-only; pairing happens in the
  // Home app via the HAP setup code surfaced by the hub's HAP transport.
  app.get("/v1/homekit/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ enabled: ctx.homekit !== null, accessoryCount: ctx.homekit?.accessoryCount() ?? 0 });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Commission a new Matter device from its setup code (installer-gated).
  app.post("/v1/matter/commission", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = CommissionMatterRequest.parse(req.body);

      const driver = ctx.matter?.driver;
      if (!driver || !driver.isConnected()) {
        throw new SupremeError("conflict", "Matter is not enabled or its controller is not running");
      }
      await ctx.home.requireRoom(input.roomId as RoomId);

      let discovered;
      try {
        discovered = await driver.commission(input.setupCode);
      } catch (err) {
        if (err instanceof MatterPairingError) throw new SupremeError("validation_failed", err.message);
        throw err;
      }

      const device = await ctx.installer.commissionDevice({
        backendId: discovered.backendId,
        name: input.name ?? discovered.suggestedName,
        roomId: input.roomId as RoomId,
        capabilities: discovered.capabilities,
        protocol: "matter",
        address: discovered.backendId,
      });
      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "matter.commission",
        resourceType: "device",
        resourceId: device.id,
        metadata: { backendId: discovered.backendId },
      });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });
}

/**
 * Matter BRIDGE routes (§ Matter Bridge Phase 6) — separate from the Matter CONTROLLER routes
 * above (`registerMatterRoutes`): the Bridge exposes SupremeOS devices outward to Matter
 * ecosystems, the Controller pairs SupremeOS to third-party Matter devices. Same installer-
 * only authorization pattern (`enforce(ctx, user, "integration", ...)`) as every other Driver
 * Store admin action in this codebase. Pairing code/QR are deliberately on their OWN endpoint
 * (`GET /v1/matter-bridge/pairing`) rather than folded into `/status`, so a future, more
 * permissive consumer of `/status` (e.g. a homeowner-facing summary) can never accidentally
 * receive the sensitive payload (§ Phase 4 §10 security review).
 */
export function registerMatterBridgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/v1/matter-bridge/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await ctx.matterBridgeStatus());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // SENSITIVE — the manual pairing code + QR payload. Never logged wholesale by this route;
  // never merged into /status. Same installer-only gate as everything else here.
  app.get("/v1/matter-bridge/pairing", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const pairing = ctx.matterBridgePairing();
      if (!pairing) throw new SupremeError("conflict", "Matter Bridge is not running");
      reply.send(pairing);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/matter-bridge/enable", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      await ctx.enableMatterBridge();
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "matter_bridge.enable", resourceType: "system", resourceId: "matter-bridge" });
      reply.send(await ctx.matterBridgeStatus());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/matter-bridge/disable", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      await ctx.disableMatterBridge();
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "matter_bridge.disable", resourceType: "system", resourceId: "matter-bridge" });
      reply.send(await ctx.matterBridgeStatus());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // DESTRUCTIVE (§ Phase 4 §7) — wipes Matter node identity/fabrics/credentials via
  // @matter/main's own ServerNode.erase(). Never called by enable/disable/restart.
  app.post("/v1/matter-bridge/factory-reset", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      await ctx.matterBridgeFactoryReset();
      await ctx.audit?.record({ homeId: ctx.homeId, actorUserId: user.id, action: "matter_bridge.factory_reset", resourceType: "system", resourceId: "matter-bridge" });
      reply.send(await ctx.matterBridgeStatus());
    } catch (err) {
      sendError(reply, err);
    }
  });
}
