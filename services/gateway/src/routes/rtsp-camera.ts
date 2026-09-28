import {
  RtspDiscoverRequest,
  RtspTestConnectionRequest,
  RtspCommissionRequest,
  SupremeError,
  type RtspDiscoverResponse,
  type RtspTestConnectionResponse,
  type RtspCommissionResponse,
} from "@supreme/contracts";
import {
  discoverCameras,
  getOnvifStreamInfo,
  testConnection,
  withCredentials,
  stripCredentials,
  validateRtspUrl,
  CommissioningError,
} from "@supreme/protocols";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";

const RTSP_CAMERA_DRIVER_KEY = "supreme-rtsp-camera";

/**
 * RTSP Camera driver — Extension Center routes (§ RTSP Camera Extension). This is a thin HTTP
 * layer only: real discovery/commissioning logic lives in `@supreme/protocols`' `rtsp/` module
 * (§ STEP 2-9). Every credential ever touches the wire here only as the request body coming IN —
 * never a response body going out (§ STEP 5/11).
 */
export function registerRtspCameraRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Requires the RTSP Camera driver to actually be installed, mirroring every other
   * discovery-gated driver panel's own "must be installed to discover" rule. */
  async function requireInstalled(): Promise<void> {
    const registry = await ctx.installer.drivers.registry();
    const entry = registry.find((r) => r.key === RTSP_CAMERA_DRIVER_KEY);
    if (!entry?.installed) {
      throw new SupremeError("conflict", "Install the RTSP Camera extension before discovering devices.");
    }
  }

  // § STEP 2/3 — "Install -> Discover Devices". Real ONVIF WS-Discovery + RTSP fallback probe
  // across every local interface, bounded by `timeoutMs`.
  app.post("/v1/drivers/rtsp/discover", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      await requireInstalled();
      const { timeoutMs } = RtspDiscoverRequest.parse(req.body ?? {});
      const cameras = await discoverCameras({ timeoutMs });
      reply.send({ cameras } satisfies RtspDiscoverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § STEP 7/8 — Test Connection, before Add Camera. ONVIF mode resolves the real stream URI
  // first (never a hand-constructed vendor URL) and validates THAT; manual mode validates the
  // installer-entered URL directly (after the SSRF/scheme guard).
  app.post("/v1/drivers/rtsp/test-connection", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      await requireInstalled();
      const body = RtspTestConnectionRequest.parse(req.body);

      if (body.mode === "onvif") {
        let info;
        try {
          info = await getOnvifStreamInfo({ deviceEndpoint: body.onvifEndpoint, credentials: { username: body.username, password: body.password } });
        } catch (err) {
          const reason = err instanceof CommissioningError ? err.message : "Could not retrieve stream information from this camera.";
          reply.send({
            result: { ok: false, checklist: [{ label: "ONVIF stream information retrieved", pass: false }], reason, diagnostics: [], codec: null },
          } satisfies RtspTestConnectionResponse);
          return;
        }
        const authenticatedUrl = withCredentials(info.mainStreamUri!, { username: body.username, password: body.password });
        const result = await testConnection({ rtspUrl: authenticatedUrl, username: body.username, password: body.password });
        reply.send({
          result,
          resolvedMainStreamUrl: info.mainStreamUri ? stripCredentials(info.mainStreamUri) : null,
          resolvedSubStreamUrl: info.subStreamUri ? stripCredentials(info.subStreamUri) : null,
          manufacturer: info.manufacturer,
          model: info.model,
        } satisfies RtspTestConnectionResponse);
        return;
      }

      const validation = validateRtspUrl(body.rtspUrl);
      if (!validation.ok) {
        reply.send({
          result: { ok: false, checklist: [{ label: "Valid RTSP URL", pass: false }], reason: validation.reason, diagnostics: [], codec: null },
        } satisfies RtspTestConnectionResponse);
        return;
      }
      const result = await testConnection({ rtspUrl: body.rtspUrl, username: body.username, password: body.password });
      reply.send({ result } satisfies RtspTestConnectionResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § STEP 7/9/11 — Commission: validate (again, server-authoritative — never trust a client-
  // reported "already tested"), persist credentials through the existing encrypted driver-config
  // secret store as a NEW instance of this driver key, and register the camera through the
  // EXISTING CameraService with a credential-free stream URL.
  app.post("/v1/drivers/rtsp/commission", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      await requireInstalled();
      const body = RtspCommissionRequest.parse(req.body);

      let mainStreamUrl: string;
      let subStreamUrl: string | null = null;
      let manufacturer: string | null = null;
      let model: string | null = null;
      let username = body.username ?? null;
      let password = body.password ?? null;

      if (body.mode === "onvif") {
        if (!body.onvifEndpoint || !body.username || !body.password) {
          throw new SupremeError("validation_failed", "ONVIF endpoint and credentials are required.");
        }
        const info = await getOnvifStreamInfo({ deviceEndpoint: body.onvifEndpoint, credentials: { username: body.username, password: body.password } });
        if (!info.mainStreamUri) throw new SupremeError("validation_failed", "This camera didn't return a stream address.");
        mainStreamUrl = info.mainStreamUri;
        subStreamUrl = info.subStreamUri;
        manufacturer = info.manufacturer;
        model = info.model;
      } else {
        if (!body.rtspUrl) throw new SupremeError("validation_failed", "An RTSP URL is required.");
        const validation = validateRtspUrl(body.rtspUrl);
        if (!validation.ok) throw new SupremeError("validation_failed", validation.reason ?? "Invalid RTSP URL.");
        mainStreamUrl = body.rtspUrl;
      }

      const hasCreds = Boolean(username && password);
      const validationUrl = hasCreds ? withCredentials(mainStreamUrl, { username: username!, password: password! }) : mainStreamUrl;
      const validation = await testConnection({ rtspUrl: validationUrl, username, password });
      if (!validation.ok) {
        reply.code(422).send({ camera: null, validation } as unknown as RtspCommissionResponse);
        return;
      }

      // § STEP 11 — credentials + the identity/URL facts persist ONLY through the existing,
      // encrypted driver-instance config store; Device.metadata below never sees a password.
      const cleanMain = stripCredentials(mainStreamUrl);
      const cleanSub = subStreamUrl ? stripCredentials(subStreamUrl) : null;
      const instance = await ctx.installer.installDriver(RTSP_CAMERA_DRIVER_KEY, undefined, { asNewInstance: true, label: body.name });
      await ctx.installer.setDriverConfig(instance.id, {
        rtspUrl: cleanMain,
        subStreamUrl: cleanSub,
        username: username ?? "",
        password: password ?? "",
        onvifEndpoint: body.onvifEndpoint ?? "",
        onvifUuid: body.onvifUuid ?? "",
      });

      const camera = await ctx.cameras.register({
        name: body.name,
        roomId: body.roomId,
        streamUrl: cleanMain,
        driverInstanceId: instance.id,
        manufacturer,
        model,
      });

      await ctx.audit?.record({
        homeId: ctx.homeId,
        actorUserId: user.id,
        action: "camera.rtsp.commission",
        resourceType: "device",
        resourceId: camera.id,
        metadata: { mode: body.mode, ip: (() => { try { return new URL(cleanMain).hostname; } catch { return null; } })() },
      });

      reply.code(201).send({ camera, validation } satisfies RtspCommissionResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });
}
