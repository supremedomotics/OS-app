import {
  RtspDiscoverRequest,
  RtspTestConnectionRequest,
  RtspCommissionRequest,
  UnifiProtectListRequest,
  UnifiProtectCommissionRequest,
  SupremeError,
  type RtspDiscoverResponse,
  type RtspTestConnectionResponse,
  type RtspCommissionResponse,
  type UnifiProtectListResponse,
  type UnifiProtectCommissionResponse,
} from "@supreme/contracts";
import {
  discoverCameras,
  getOnvifStreamInfo,
  testConnection,
  withCredentials,
  stripCredentials,
  validateRtspUrl,
  validateOnvifEndpointUrl,
  CommissioningError,
  listUnifiCameras,
  commissionUnifiCameras,
  UnifiProtectError,
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
        const endpointValidation = await validateOnvifEndpointUrl(body.onvifEndpoint);
        if (!endpointValidation.ok) {
          reply.send({
            result: { ok: false, checklist: [{ label: "Valid ONVIF endpoint", pass: false }], reason: endpointValidation.reason, diagnostics: [], codec: null },
          } satisfies RtspTestConnectionResponse);
          return;
        }
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

      const validation = await validateRtspUrl(body.rtspUrl);
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
        const endpointValidation = await validateOnvifEndpointUrl(body.onvifEndpoint);
        if (!endpointValidation.ok) {
          throw new SupremeError("validation_failed", endpointValidation.reason ?? "Invalid ONVIF endpoint.");
        }
        const info = await getOnvifStreamInfo({ deviceEndpoint: body.onvifEndpoint, credentials: { username: body.username, password: body.password } });
        if (!info.mainStreamUri) throw new SupremeError("validation_failed", "This camera didn't return a stream address.");
        mainStreamUrl = info.mainStreamUri;
        subStreamUrl = info.subStreamUri;
        manufacturer = info.manufacturer;
        model = info.model;
      } else {
        if (!body.rtspUrl) throw new SupremeError("validation_failed", "An RTSP URL is required.");
        const validation = await validateRtspUrl(body.rtspUrl);
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
  /** Maps a UniFi failure to the shared error envelope with the plain-English message only —
   * diagnostics (never the API key/token) ride along in `details`. */
  function unifiError(err: unknown): unknown {
    if (!(err instanceof UnifiProtectError)) return err;
    const code = err.kind === "unreachable" || err.kind === "rate-limited" ? "backend_unavailable" : "validation_failed";
    return new SupremeError(code, err.message);
  }

  // § UniFi Protect mode — list the console's cameras (id/name/model/state only). The API key is
  // used for this one request and never stored, logged or echoed.
  app.post("/v1/drivers/rtsp/unifi/cameras", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      await requireInstalled();
      const body = UnifiProtectListRequest.parse(req.body);
      const cameras = await listUnifiCameras({ host: body.host, apiKey: body.apiKey }).catch((e) => {
        throw unifiError(e);
      });
      reply.send({ cameras } satisfies UnifiProtectListResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § UniFi Protect mode — commission selected cameras. Each is validated with the real RTSP
  // handshake and registered through the same path as `mode:"rtsp"` commission; the UniFi camera id
  // is the identity, so re-commissioning never duplicates a device.
  app.post("/v1/drivers/rtsp/unifi/commission", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "camera", null, "create");
      await requireInstalled();
      const body = UnifiProtectCommissionRequest.parse(req.body);

      const results = await commissionUnifiCameras({
        host: body.host,
        apiKey: body.apiKey,
        cameras: body.cameras,
        deps: {
          // Identity = the UniFi camera id stored on the per-camera driver instance. An instance
          // whose device was removed is reused (not duplicated) by `register` below.
          findExisting: async (unifiCameraId) => {
            const instances = await ctx.installer.drivers.listInstances(RTSP_CAMERA_DRIVER_KEY);
            const ids = new Set(instances.filter((i) => (i.config as Record<string, unknown>).unifiCameraId === unifiCameraId).map((i) => String(i.id)));
            if (ids.size === 0) return null;
            const device = (await ctx.home.listDevices()).find(
              (d) => d.supremeType === "camera" && ids.has(String(d.metadata?.driverInstanceId ?? "")),
            );
            return device ? { deviceId: device.id } : null;
          },
          register: async ({ unifiCameraId, name, model, mainUrl, subUrl }) => {
            // The RTSPS URL carries a secret token in its path and there is no credential-injection
            // hook for that (CameraService only injects userinfo), so — exactly like a manual add —
            // the URL is stored as the camera's streamUrl. It is never logged.
            const instances = await ctx.installer.drivers.listInstances(RTSP_CAMERA_DRIVER_KEY);
            let instance = instances.find((i) => (i.config as Record<string, unknown>).unifiCameraId === unifiCameraId);
            if (!instance) instance = await ctx.installer.installDriver(RTSP_CAMERA_DRIVER_KEY, undefined, { asNewInstance: true, label: name });
            await ctx.installer.setDriverConfig(instance.id, {
              rtspUrl: mainUrl,
              subStreamUrl: subUrl,
              username: "",
              password: "",
              onvifEndpoint: "",
              onvifUuid: "",
              unifiCameraId,
            });
            const camera = await ctx.cameras.register({
              name,
              roomId: body.roomId,
              streamUrl: mainUrl,
              driverInstanceId: instance.id,
              manufacturer: "Ubiquiti",
              model,
            });
            await ctx.audit?.record({
              homeId: ctx.homeId,
              actorUserId: user.id,
              action: "camera.rtsp.commission",
              resourceType: "device",
              resourceId: camera.id,
              metadata: { mode: "unifi-protect", unifiCameraId },
            });
            return { deviceId: camera.id };
          },
        },
      }).catch((e) => {
        throw unifiError(e);
      });

      reply.send({ results } satisfies UnifiProtectCommissionResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });
}
