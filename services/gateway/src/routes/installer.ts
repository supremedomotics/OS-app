import {
  ActivateLicenseRequest,
  BindProtocolRequest,
  CommissionRequest,
  DiscoverRequest,
  ProbeRequest,
  InstallDriverRequest,
  ApproveDeviceRequest,
  BackupScheduleInput,
  RestoreRequest,
  RollbackDriverRequest,
  SetDriverEnabledRequest,
  SupremeError,
  type CatalogList,
  type DiagnosticsReport,
  type DiscoveryList,
  type ProbeResult,
  type InstalledDriverList,
  type InstalledDriverResponse,
  type LicenseStatus,
  type ProjectExport,
  type ProtocolBindingList,
  type SystemUpdate,
  type BackupList,
  type BackupStatus,
  type BackupScheduleResponse,
  type PendingDeviceList,
} from "@supreme/contracts";
import type { CapabilityKind, DeviceId, DriverId, RoomId } from "@supreme/domain-model";
import type { UnifiedKnxDevice, BindingPlanItem } from "@supreme/protocols";
import { CasambiProtocolDriver, CasambiLocalRestClient, CasambiUdpEngine, buildFailureAnalysisReport, buildReceiveCertificationReport, type LanForensicsInput } from "@supreme/protocols";
import { NatsUdpTransportClient, LocalDirectUdpTransport, queryLanHealth, queryLanForensics, type LanDiagnosticsSnapshot, type LanForensicsResponse } from "@supreme/lan";
import { resolveCasambiCloudCredentials } from "../native-driver-factory.js";
import type { FastifyInstance } from "fastify";
import { authenticate, enforce } from "../auth.js";
import type { AppContext } from "../context.js";
import { sendError } from "../http-errors.js";
import { collectSystemHealth } from "../system-health.js";
import { probeAvr } from "../avr-probe.js";
import { probeYamaha } from "../yamaha-probe.js";
import { OtaChecker } from "../ota.js";

/**
 * Installer & admin routes (§9, §14): Driver Store, discovery + commissioning,
 * diagnostics, backup/restore, project export, and licensing. Authorized as
 * `integration` admin actions (installer/admin/master via the policy engine).
 */
export function registerInstallerRoutes(app: FastifyInstance, ctx: AppContext): void {
  const i = () => ctx.installer;

  // ── Driver Store ─────────────────────────────────────────────────────────────
  app.get("/v1/drivers/catalog", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const catalog = (await i().drivers.browse()).map((e) => ({
        manifest: e.bundle.manifest,
        status: e.bundle.status,
        signingKeyId: e.signingKeyId,
      }));
      const body: CatalogList = { catalog };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/drivers", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const body: InstalledDriverList = { drivers: await i().drivers.listInstalled() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Unified driver registry: every driver merged with its installed state, config schema and
  // supported operations. The Driver Manager UI populates entirely from this — any current/future
  // driver appears automatically. Secrets are masked.
  app.get("/v1/drivers/registry", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ drivers: await i().driverRegistry() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Driver Diagnostics (§ Diagnostics): full Driver Lifecycle picture for every driver —
  // registration stage, protocol status, ownership/binding counts, health, last error,
  // reconnect history — without reading logs.
  app.get("/v1/drivers/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ drivers: await i().driverDiagnostics(), providers: ctx.sil.providers.countsByState() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Per-driver configuration (schema + masked values), and a schema-validated update.
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().getDriverConfig(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: { config?: Record<string, unknown> } }>("/v1/drivers/:id/config", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().setDriverConfig(req.params.id as DriverId, req.body?.config ?? {}));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/drivers/install", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "create");
      const { key, version } = InstallDriverRequest.parse(req.body);
      const driver = await i().installDriver(key, version);
      const body: InstalledDriverResponse = { driver };
      reply.code(201).send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { key: string } }>("/v1/drivers/:key/update", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const driver = await i().drivers.update(req.params.key);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { key: string } }>("/v1/drivers/:key/rollback", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const { version } = RollbackDriverRequest.parse(req.body);
      const driver = await i().drivers.rollback(req.params.key, version);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/enabled", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const { enabled } = SetDriverEnabledRequest.parse(req.body);
      const driver = await i().enableDriver(req.params.id as DriverId, enabled);
      reply.send({ driver } satisfies InstalledDriverResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/drivers/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "delete");
      await i().uninstallDriver(req.params.id as DriverId);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Per-driver health, logs, and connect/disconnect (Driver Manager operations).
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/health", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().driverHealth(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/drivers/:id/logs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await i().driverLogs(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Settings → Logs (§ Diagnostics): every driver install/enable/connect/native-connection
  // event plus device control operation outcomes, in one unified stream — not scattered
  // across each Extension Center card.
  app.get<{ Querystring: { limit?: string } }>("/v1/system/logs", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const limit = req.query.limit ? Number.parseInt(req.query.limit, 10) : undefined;
      reply.send({ entries: i().systemLogs(Number.isFinite(limit) ? limit : undefined) });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/connect", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().connectDriver(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/disconnect", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      reply.send(await i().disconnectDriver(req.params.id as DriverId));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Casambi Driver Refactor — Foundation: the dedicated Casambi Diagnostics page's snapshot
  // (Connection Type, Gateway, Latency, Entities, Online/Offline, Reconnects, Last Event,
  // REST/UDP Status, Health). Driver-level, not per-device — unlike `/v1/devices/:id/diagnostics`.
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/casambi/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const entry = (await i().drivers.registry()).find((e) => e.installedId === req.params.id);
      if (!entry || !entry.protocols.includes("casambi")) throw new SupremeError("not_found", "casambi driver not installed");
      const driver = ctx.sil.getNativeDriver("casambi");
      if (!(driver instanceof CasambiProtocolDriver)) throw new SupremeError("not_found", "casambi driver is not currently running");
      reply.send(driver.getCasambiDiagnostics());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Casambi Local Gateway — one-time Cloud name sync. Local mode's UDP/REST protocol has no
  // field for a fixture's real name anywhere (confirmed against every locally-reachable Lithernet
  // interface); this is the one place a Local-mode Casambi instance is allowed to reach the
  // Casambi Cloud API, and only for this — a REST-only session (no WebSocket, no live
  // subscription) that fetches names and immediately discards the session. Reuses the SAME
  // apiKey/email/password/networkId config fields the driver's Cloud mode already has (they're
  // optional, not required, when connectionType=local) — no new config surface, no new credential
  // to manage separately from what's already there. Command/discovery/live-state stay on Local
  // UDP unconditionally; this route can never change what transport the driver actually runs on.
  //
  // Credential precedence: this driver instance's own saved config first (an installer explicitly
  // set a different Casambi account for this job), falling back to the deployment-wide
  // SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD/NETWORK_ID env vars (config.ts's existing `secret()`
  // helper — same `_FILE` convention as every other deployment secret) — the SAME env vars that
  // already auto-connect Cloud mode with zero installer input (bootstrap.ts). Set once at
  // deployment time, this makes the sync work with no typing in the UI for every hub in the
  // fleet, while never putting a real credential in source control — see SESSION_HANDOFF.md for
  // why a hardcoded default was explicitly rejected in favor of this.
  // § Shared by both Casambi Local Gateway Cloud actions (name sync + device discovery) — same
  // driver-instance-config-then-fleet-default credential precedence, so it isn't duplicated.
  function resolveCreds(entryConfig: Record<string, unknown>) {
    const fleetDefault =
      ctx.config.casambiApiKey && ctx.config.casambiEmail && ctx.config.casambiPassword
        ? {
            apiKey: ctx.config.casambiApiKey,
            email: ctx.config.casambiEmail,
            password: ctx.config.casambiPassword,
            ...(ctx.config.casambiNetworkId ? { networkId: ctx.config.casambiNetworkId } : {}),
          }
        : undefined;
    return resolveCasambiCloudCredentials(entryConfig, fleetDefault);
  }

  app.post<{ Params: { id: string } }>("/v1/drivers/:id/casambi/sync-names", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const entry = (await i().drivers.registry()).find((e) => e.installedId === req.params.id);
      if (!entry || !entry.protocols.includes("casambi")) throw new SupremeError("not_found", "casambi driver not installed");
      const driver = ctx.sil.getNativeDriver("casambi");
      if (!(driver instanceof CasambiProtocolDriver)) throw new SupremeError("not_found", "casambi driver is not currently running");

      const creds = resolveCreds(entry.config as Record<string, unknown>);
      if (!creds) {
        throw new SupremeError(
          "validation_failed",
          "Casambi Cloud API key, email, and password are required to sync names — set them on this driver, or configure SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD as a deployment-wide default.",
        );
      }
      const result = await driver.syncNamesFromCloud(creds);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Casambi Local Gateway — Cloud device discovery: pre-populates the device list with real
  // names from the Cloud account, honestly marked "awaiting local signal" until each unit's
  // first genuine local UDP packet confirms it (see CasambiProtocolDriver.discoverFromCloud's own
  // doc comment). Command/feedback for these devices, once bound, still goes exclusively through
  // Local UDP — never through this Cloud session, which is discarded immediately after the fetch.
  app.post<{ Params: { id: string } }>("/v1/drivers/:id/casambi/discover-from-cloud", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "update");
      const entry = (await i().drivers.registry()).find((e) => e.installedId === req.params.id);
      if (!entry || !entry.protocols.includes("casambi")) throw new SupremeError("not_found", "casambi driver not installed");
      const driver = ctx.sil.getNativeDriver("casambi");
      if (!(driver instanceof CasambiProtocolDriver)) throw new SupremeError("not_found", "casambi driver is not currently running");

      const creds = resolveCreds(entry.config as Record<string, unknown>);
      if (!creds) {
        throw new SupremeError(
          "validation_failed",
          "Casambi Cloud API key, email, and password are required to discover devices — set them on this driver, or configure SUPREME_CASAMBI_API_KEY/EMAIL/PASSWORD as a deployment-wide default.",
        );
      }
      const result = await driver.discoverFromCloud(creds);
      reply.send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § LAN Transport Phase 2 — Transport Monitor: the developer-grade, layered view (Transport /
  // Casambi Adapter / Driver from the driver itself; a service-wide "NATS"/`supreme-lan` layer
  // attached here, since only the Gateway route holds the event bus `queryLanHealth` needs). This
  // is deliberately a SEPARATE endpoint from `casambi/diagnostics` above — that one is the stable,
  // long-standing installer-facing snapshot; this one is a debugging tool and its shape may grow
  // as more LAN protocols migrate onto `@supreme/lan`. `lan`/`lanQueryError` are honestly `null`
  // (never a fabricated empty snapshot) whenever the resolved transport isn't NATS-backed, or a
  // real `supreme-lan` service didn't answer in time.
  app.get<{ Params: { id: string } }>("/v1/drivers/:id/casambi/transport-monitor", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const entry = (await i().drivers.registry()).find((e) => e.installedId === req.params.id);
      if (!entry || !entry.protocols.includes("casambi")) throw new SupremeError("not_found", "casambi driver not installed");
      const driver = ctx.sil.getNativeDriver("casambi");
      if (!(driver instanceof CasambiProtocolDriver)) throw new SupremeError("not_found", "casambi driver is not currently running");
      const monitor = driver.getCasambiTransportMonitor();
      let lan: LanDiagnosticsSnapshot | null = null;
      let lanQueryError: string | null = null;
      if (monitor.transport?.backend === "nats" && ctx.config.natsUrl) {
        try {
          lan = await queryLanHealth(ctx.bus, 2_000);
        } catch (err) {
          lanQueryError = err instanceof Error ? err.message : String(err);
        }
      }
      // § Final Hardware Validation — Failure Analysis, computed from the SAME snapshot just
      // returned above (never a fresh/separate measurement) — "prove exactly where the pipeline
      // stopped," mechanized as a real, reusable field on this same response.
      const failureAnalysis = buildFailureAnalysisReport(monitor);
      reply.send({ ...monitor, lan, lanQueryError, failureAnalysis });
    } catch (err) {
      sendError(reply, err);
    }
  });

  /**
   * § Runtime Data Path Verification — the full receive-path evidence bundle: the eleven
   * instrumented pipeline stages, the automatic root-cause verdict, the Wireshark comparison, and
   * the seven-section certification report.
   *
   * Deliberately separate from `/transport-monitor` above: this one asks `supreme-lan` for deep
   * forensics (it reads `/proc` and walks every session on the service side), so it is requested
   * when someone is actively diagnosing rather than on every poll.
   *
   * `?wiresharkPackets=N` supplies the one number SupremeOS genuinely cannot observe about itself
   * — how many packets a host-side capture saw over the same window. Without it the comparison
   * reports "not supplied" and the root cause stays honestly `unknown` in the one case where two
   * mutually exclusive causes produce identical counters.
   */
  app.get<{ Params: { id: string }; Querystring: { wiresharkPackets?: string; captureFilter?: string } }>(
    "/v1/drivers/:id/casambi/receive-pipeline",
    async (req, reply) => {
      try {
        const user = await authenticate(ctx, req);
        await enforce(ctx, user, "integration", null, "view");
        const entry = (await i().drivers.registry()).find((e) => e.installedId === req.params.id);
        if (!entry || !entry.protocols.includes("casambi")) throw new SupremeError("not_found", "casambi driver not installed");
        const driver = ctx.sil.getNativeDriver("casambi");
        if (!(driver instanceof CasambiProtocolDriver)) throw new SupremeError("not_found", "casambi driver is not currently running");

        const snapshot = driver.getCasambiTransportMonitor();
        let lan: LanForensicsResponse | null = null;
        let lanQueryError: string | null = null;
        if (ctx.config.natsUrl) {
          try {
            lan = await queryLanForensics(ctx.bus, 5_000);
          } catch (err) {
            // Reported, never substituted with an empty snapshot: "supreme-lan did not answer" and
            // "supreme-lan answered that it saw nothing" must never look alike.
            lanQueryError = err instanceof Error ? err.message : String(err);
          }
        }

        const parsed = Number(req.query.wiresharkPackets);
        const wireshark =
          Number.isInteger(parsed) && parsed >= 0 ? { packets: parsed, captureFilter: req.query.captureFilter ?? undefined, capturedAt: new Date().toISOString() } : null;

        // `LanForensicsResponse` types its payloads as `unknown` on purpose — the transport's wire
        // protocol must not restate the forensics module's internals (the same rule that keeps
        // deployment vocabulary out of it). The Gateway is the one boundary that knows both sides,
        // so the narrowing happens here. It cannot throw: every field of `LanForensicsInput` is
        // optional, so an unexpected shape degrades to the same `null`s as "not collected".
        const report = buildReceiveCertificationReport({ snapshot, lan: lan as LanForensicsInput | null, wireshark });
        reply.send({ ...report, lanQueryError });
      } catch (err) {
        sendError(reply, err);
      }
    },
  );

  // Local Gateway setup wizard actions (§ Driver Setup Wizard; § Casambi Local Gateway Auth + UDP
  // Diagnostics). "Test Connection" is real and staged, never a single reachable/unreachable
  // boolean: it reports REST reachability + HTTP auth result (via the configured Gateway
  // Username/Password, never Cloud credentials), and — because Casambi's UDP transport is
  // connectionless — the real, verifiable stages of the UDP side (socket created, socket bound,
  // probe packet transmitted, any notification received) instead of treating "no reply within
  // the test window" as a failure. Never calls `/set/target_value` (always writes a real value to
  // a real target) and the UDP probe uses opcode 0x39 with Request=0xFF ("own node") — neither
  // path can ever actuate a real device. "Discover gateway" stays an honest, structured "not
  // implemented" response — no enumeration/discovery endpoint (SSDP, mDNS, or otherwise) is
  // documented anywhere in the supplied Lithernet reference set for this gateway.
  app.post<{
    Body: {
      gatewayIp?: string;
      restPort?: number;
      udpPort?: number;
      netId?: number;
      dataFormat?: string;
      gatewayUsername?: string;
      gatewayPassword?: string;
    };
  }>("/v1/commissioning/casambi/test-connection", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { gatewayIp, restPort, udpPort, netId, dataFormat, gatewayUsername, gatewayPassword } = req.body ?? {};
      if (!gatewayIp || !Number.isFinite(restPort) || !Number.isFinite(udpPort)) {
        reply.send({
          implemented: true,
          rest: { reachable: false, httpStatus: null, authFailed: null },
          udp: {
            socketCreated: false,
            socketBound: false,
            packetSent: false,
            localAddress: null,
            localPort: null,
            remoteAddress: gatewayIp ?? null,
            remotePort: udpPort ?? null,
            notificationReceived: false,
            packetsReceived: 0,
            averageLatencyMs: null,
            lastError: null,
            recentTraces: [],
          },
          message: "Missing gatewayIp/restPort/udpPort — enter the Local Gateway's connection details first.",
        });
        return;
      }
      const format = dataFormat === "dec-hash" ? "dec-hash" : "hex-dot";
      const rest = new CasambiLocalRestClient({ gatewayIp, restPort: restPort as number, gatewayUsername, gatewayPassword });
      const restResult = await rest.testConnection();

      // § LAN Transport Phase 2 — resolve the SAME transport a real persistent driver would use
      // (see installer-context.ts's nativeDriverContext()), so a Test Connection result reflects
      // the actual network vantage point in production rather than always testing from the
      // Gateway's own bridge-network process.
      const udpTransportFactory = ctx.config.natsUrl
        ? () => new NatsUdpTransportClient(ctx.bus)
        : () => new LocalDirectUdpTransport();
      const udp = new CasambiUdpEngine({ gatewayIp, udpPort: udpPort as number, netId: netId ?? 0, format, udpTransportFactory });
      let socketCreated = false;
      let socketBound = false;
      try {
        await udp.start();
        socketCreated = true;
        socketBound = true;
      } catch {
        // `dgram.createSocket()` itself has no documented failure path — only the subsequent
        // bind can fail (EADDRINUSE, permission denied), so the socket was still "created."
        socketCreated = true;
        socketBound = false;
      }
      let notificationReceived = false;
      if (socketBound) {
        notificationReceived = await udp.probe(2_000);
      }
      const udpResult = {
        socketCreated,
        socketBound,
        packetSent: udp.packetsSent > 0,
        localAddress: udp.localAddress,
        localPort: udp.localPort,
        remoteAddress: gatewayIp,
        remotePort: udpPort as number,
        notificationReceived,
        packetsReceived: udp.packetsReceived,
        averageLatencyMs: udp.averageLatencyMs,
        lastError: udp.lastError,
        // § UDP Receive Pipeline Audit, Step 6 — every datagram this test window actually saw,
        // parsed or not, so a real capture can be cross-checked against what SupremeOS received.
        recentTraces: udp.recentTraces,
      };
      await udp.stop().catch(() => {});

      const restMessage = !restResult.reachable
        ? "REST unreachable — check the IP address and REST port."
        : restResult.authFailed
          ? "REST reachable, but the gateway rejected the configured Gateway Username/Password."
          : "REST reachable.";
      const udpMessage = !udpResult.socketBound
        ? `UDP socket could not bind (${udpResult.lastError ?? "unknown error"}) — check the UDP port is not already in use.`
        : !udpResult.packetSent
          ? `UDP socket bound, but the test packet failed to send (${udpResult.lastError ?? "unknown error"}).`
          : udpResult.notificationReceived || udpResult.packetsReceived > 0
            ? "UDP active — the gateway is sending notifications."
            : "UDP socket bound and listening — waiting for the gateway's first notification. This is normal for a connectionless protocol and does not by itself mean the gateway is unreachable.";

      reply.send({
        implemented: true,
        rest: restResult,
        udp: udpResult,
        message: `${restMessage} ${udpMessage}`,
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/casambi/discover-gateway", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      // § Discovery UX correction — this endpoint is about GATEWAY discovery only (finding the
      // Lithernet Gateway's own IP), which genuinely has no documented API. It says nothing about
      // DEVICE discovery, which IS implemented and automatic once the gateway is reachable
      // (`local-discovery.ts` builds units from incoming NotifyControlValues UDP notifications).
      // The previous wording ("Auto-discovery is not implemented") conflated the two and wrongly
      // read as "Casambi devices must be added by hand."
      reply.send({
        implemented: false,
        gateways: [],
        message:
          "Automatic GATEWAY discovery is not available — the Lithernet Gateway documentation defines no network discovery API (no REST enumeration endpoint, no SSDP/mDNS profile), so its IP must be entered manually. This does not affect DEVICE discovery: once the gateway is connected, Casambi devices are discovered automatically from incoming UDP notifications, with no manual device creation.",
      });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Discovery & commissioning ────────────────────────────────────────────────
  app.post("/v1/commissioning/discover", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { protocol, driverIds } = DiscoverRequest.parse(req.body ?? {});
      // Discovery Driver Selector (§ Priority 4): `driverIds` (even a `protocol`-only
      // legacy request) always routes through discoverWithStatus() so driver-name
      // labeling and failure isolation apply uniformly — never a second discovery path.
      const { discovered, driverResults } = await i().discoverWithStatus(
        driverIds ?? (protocol ? (await i().discoverableDrivers()).filter((d) => d.protocols.includes(protocol)).map((d) => d.installedId) : undefined),
      );
      const body: DiscoveryList = { discovered, driverResults };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // A targeted, single-address reachability probe (§ AVR Intelligent Manual Add) — opens a
  // real connection to confirm an installer-typed IP before committing to commission anything.
  // "avr" (Denon/Marantz Telnet) and "yamaha" (YXC/MusicCast) implement a real probe — the
  // only two AV protocols with a real driver in this fleet. HEOS has no zone concept (opaque
  // player pids instead), so it isn't probed the same way. Every other AV brand named in the
  // manual-add UI (Onkyo/Pioneer/Sony/Arcam/Anthem/NAD) has zero protocol implementation
  // anywhere in this codebase — probing them here would mean fabricating a result, so they're
  // rejected explicitly instead.
  app.post("/v1/commissioning/probe", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { protocol, address } = ProbeRequest.parse(req.body ?? {});
      let body: ProbeResult;
      if (protocol === "avr") body = await probeAvr(address);
      else if (protocol === "yamaha") body = await probeYamaha(address);
      else throw new SupremeError("validation_failed", `probing is not yet implemented for protocol '${protocol}'`);
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Device Approval (§ Device Approval): scan → pending queue → approve/reject ─────
  app.post("/v1/commissioning/scan", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { protocol, driverIds } = DiscoverRequest.parse(req.body ?? {});
      const resolvedDriverIds = driverIds ?? (protocol ? (await i().discoverableDrivers()).filter((d) => d.protocols.includes(protocol)).map((d) => d.installedId) : undefined);
      reply.send({ pending: await i().scanForApproval(undefined, resolvedDriverIds) } satisfies PendingDeviceList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/devices/pending", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "view");
      reply.send({ pending: await i().listPendingDevices() } satisfies PendingDeviceList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/devices/pending/:id/approve", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = ApproveDeviceRequest.parse(req.body);
      const device = await i().approvePendingDevice(req.params.id, { ...input, roomId: input.roomId ? (input.roomId as RoomId) : undefined });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post<{ Params: { id: string } }>("/v1/devices/pending/:id/reject", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      await i().rejectPendingDevice(req.params.id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/v1/devices/pending/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      await i().removePendingDevice(req.params.id);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/commission", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = CommissionRequest.parse(req.body);
      const device = await i().commissionDevice({
        ...input,
        roomId: input.roomId ? (input.roomId as RoomId) : undefined,
      });
      reply.code(201).send({ device });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── ETS group-address import (§4): KNX project → device cards ─────────────────
  //
  // BODY SIZE (§ ETS Import production blocker): the gateway's global `bodyLimit`
  // (server.ts, 1 MiB) exists to blunt oversized-payload abuse on the JSON API — a
  // sound default for every other route, but wrong for this one. A `.knxproj` upload is
  // base64-encoded inside a JSON string (≈33% inflation over the binary ZIP) and a
  // commercial ETS export with thousands of group addresses routinely exceeds 1 MiB as
  // plain XML alone; the 1 MiB cap is what actually produces "Request body is too
  // large" (Fastify's own FST_ERR_CTP_BODY_TOO_LARGE, confirmed against the installed
  // fastify package's error source, not guessed). Investigated and ruled out as the
  // cause: Caddy (infra/hub-compose/Caddyfile has no request_body/max_size directive —
  // no proxy-level cap exists), the multipart parser (not in play — these routes accept
  // JSON, not multipart/form-data), and the XML/ZIP parser (services/commissioning's
  // runKnxImport/unzipKnxproj operate in-memory on whatever buffer they're handed; they
  // were never reached because the body was rejected before parsing started).
  //
  // Fix: override ONLY these two content-receiving routes to a generous 64 MiB ceiling
  // — enormous headroom for even large multi-building commercial projects (tens of
  // thousands of group addresses is single-digit MB of XML) — while leaving the global
  // 1 MiB default untouched for every other endpoint, preserving its abuse-prevention
  // intent exactly where it still applies. NOT a blanket "raise the limit" — a scoped,
  // justified exception on the two routes that legitimately need it.
  //
  // Explicitly NOT implemented this pass (a materially larger, separate feature): a
  // streaming multipart upload protocol, incremental/streaming XML parsing, real-time
  // progress reporting, mid-upload cancellation, or resumable/interrupted-import
  // recovery. The in-memory parse this fix unblocks is bounded (64 MiB ceiling, not
  // unbounded), which is sufficient for the reported bug (a "relatively small" project
  // failing) and for realistic large commercial projects, but is not the fully
  // streaming pipeline the request describes as the end state.
  const ETS_IMPORT_BODY_LIMIT = 64 * 1024 * 1024;

  app.post("/v1/commissioning/import/knx", { bodyLimit: ETS_IMPORT_BODY_LIMIT }, async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { content?: unknown; knxproj?: unknown; password?: unknown };
      if (typeof body?.knxproj === "string" && body.knxproj.length > 0) {
        const password = typeof body.password === "string" ? body.password : undefined;
        reply.code(201).send(await i().importKnxProject(body.knxproj, password));
        return;
      }
      const content = typeof body?.content === "string" ? body.content : typeof req.body === "string" ? req.body : "";
      if (!content) throw new SupremeError("validation_failed", "provide the ETS export as `content`, or a .knxproj as base64 `knxproj`");
      reply.code(201).send(await i().importKnx(content));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Parse-only preview: same inputs as the import route, but nothing is committed — the
  // installer reviews the device list (room, detected circuit type) before saving.
  app.post("/v1/commissioning/import/knx/preview", { bodyLimit: ETS_IMPORT_BODY_LIMIT }, async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { content?: unknown; knxproj?: unknown; password?: unknown };
      if (typeof body?.knxproj === "string" && body.knxproj.length > 0) {
        const password = typeof body.password === "string" ? body.password : undefined;
        reply.send(await i().previewKnxProject(body.knxproj, password));
        return;
      }
      const content = typeof body?.content === "string" ? body.content : typeof req.body === "string" ? req.body : "";
      if (!content) throw new SupremeError("validation_failed", "provide the ETS export as `content`, or a .knxproj as base64 `knxproj`");
      reply.send(await i().previewKnx(content));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Save a (possibly edited) preview: commissions every included device, no re-parsing.
  app.post("/v1/commissioning/import/knx/commit", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { devices?: unknown };
      if (!Array.isArray(body?.devices)) throw new SupremeError("validation_failed", "provide `devices` (the reviewed preview list)");
      reply.code(201).send(await i().commitKnxImport(body.devices));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Supreme KNX Unified Device Intelligence (§ Phase 5) ────────────────────────
  // Production installer flow for KNX: Scan → discoverUnified() → Confidence Engine →
  // Room Assignment → Duplicate Detection → Binding Engine → Installer Queue → Approve.
  // No raw KNX protocol object is returned here — every item is an already-intelligent
  // Unified Device with a decided section (ready/needs_review/duplicates/conflicts).
  // ETS Project Import is a signal SOURCE into this same route (§ Unify ETS Import &
  // Discovery Pipeline) — `content`/`knxproj` are optional alongside `ets`/`gateway`, so
  // this is the single entry point every KNX onboarding method (live discovery, ETS
  // import, and any future CSV/manual/AI source) funnels through. Needs the same
  // ETS_IMPORT_BODY_LIMIT the legacy import routes already needed, for the same reason:
  // an ETS project's content can legitimately be tens of MB.
  app.post("/v1/commissioning/knx/queue", { bodyLimit: ETS_IMPORT_BODY_LIMIT }, async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as {
        ets?: unknown;
        gateway?: { host?: unknown; port?: unknown };
        content?: unknown;
        knxproj?: unknown;
        password?: unknown;
      } | undefined;
      const ets = Array.isArray(body?.ets) ? (body!.ets as { id: string; name: string; room?: string | null; description?: string | null }[]) : undefined;
      const gateway = typeof body?.gateway?.host === "string"
        ? { host: body.gateway.host, port: typeof body.gateway.port === "number" ? body.gateway.port : undefined }
        : undefined;
      const etsSource = typeof body?.knxproj === "string" && body.knxproj.length > 0
        ? { kind: "knxproj" as const, base64: body.knxproj, password: typeof body.password === "string" ? body.password : undefined }
        : typeof body?.content === "string" && body.content.length > 0
          ? { kind: "text" as const, content: body.content }
          : undefined;
      reply.send(await i().knxInstallerQueue({ ets, gateway, etsSource }));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Non-blocking counterpart (§ Pass 11.1): same inputs, but returns a jobId immediately
  // instead of awaiting the parse/synthesize/classify pipeline inline on the request
  // thread — poll GET .../job/:jobId for status/result. See `startKnxImportJob` doc.
  // ponytail: diagnostic-only lifecycle tracing (KNX_TRACE), scoped to this one route via
  // Fastify's per-route hook options — never fires for any other route in the app, so it
  // cannot regress unrelated tests. Each hook logs only request metadata (id/method/url/
  // headers), never the body. Purpose: `handler_entered` above only proves the LAST stage
  // (the handler itself) was reached — it cannot tell us whether a slow Fastify lifecycle
  // stage (onRequest/preParsing/preValidation/preHandler, all of which run BEFORE the
  // handler function is even invoked) is where a stuck request is actually stalling. On
  // the next live hang, whichever KNX_TRACE line is the LAST one logged for that request's
  // reqId identifies the exact stage Fastify itself is stuck in — remove once resolved.
  const knxTraceHook = (stage: string) => async (req: import("fastify").FastifyRequest) => {
    req.log.info(
      {
        stage: `KNX_TRACE ${stage}`,
        reqId: req.id,
        method: req.method,
        url: req.url,
        contentType: req.headers["content-type"],
        contentLength: req.headers["content-length"],
        transferEncoding: req.headers["transfer-encoding"],
        remoteAddress: req.ip,
      },
      "knx queue/job lifecycle trace",
    );
  };

  // § P0.32 — the metadata-only preParsing hook above proved this route's request STREAM
  // itself is where a live stall happens (preParsing fires, preValidation never does) —
  // it cannot say whether the raw bytes ever fully arrive, or arrive but the parser never
  // finishes. Fastify's `preParsing` hook is the one official place that can see (and,
  // via `done(null, newStream)`, transparently re-wrap) the actual raw request stream
  // BEFORE any parser touches it — this is a passthrough Transform that counts
  // bytes/chunks and logs stream lifecycle events, changing nothing about the data itself.
  const knxStreamTraceHook = async (
    req: import("fastify").FastifyRequest,
    _reply: import("fastify").FastifyReply,
    payload: NodeJS.ReadableStream,
  ): Promise<NodeJS.ReadableStream> => {
    const { Transform } = await import("node:stream");
    const expected = Number(req.headers["content-length"]) || null;
    let bytesReceived = 0;
    let chunks = 0;
    let firstChunkAt: number | null = null;
    const startedAt = Date.now();
    req.log.info({ stage: "KNX_TRACE preParsing", reqId: req.id, contentLength: expected }, "knx queue/job stream trace");
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        if (firstChunkAt === null) firstChunkAt = Date.now();
        chunks += 1;
        bytesReceived += chunk.length;
        cb(null, chunk);
      },
    });
    counter.on("end", () => {
      req.log.info(
        { stage: "KNX_TRACE body_end", reqId: req.id, bytesReceived, expected, chunks, durationMs: Date.now() - startedAt, firstChunkDelayMs: firstChunkAt ? firstChunkAt - startedAt : null },
        "knx queue/job stream trace",
      );
    });
    counter.on("close", () => {
      req.log.info({ stage: "KNX_TRACE body_close", reqId: req.id, bytesReceived, expected, chunks }, "knx queue/job stream trace");
    });
    counter.on("error", (err) => {
      req.log.info({ stage: "KNX_TRACE body_error", reqId: req.id, bytesReceived, expected, chunks, error: err.message }, "knx queue/job stream trace");
    });
    payload.on("aborted", () => {
      req.log.info({ stage: "KNX_TRACE body_aborted", reqId: req.id, bytesReceived, expected, chunks, durationMs: Date.now() - startedAt }, "knx queue/job stream trace");
    });
    payload.pipe(counter);
    return counter;
  };

  app.post(
    "/v1/commissioning/knx/queue/job",
    {
      bodyLimit: ETS_IMPORT_BODY_LIMIT,
      onRequest: knxTraceHook("onRequest"),
      preParsing: knxStreamTraceHook,
      preValidation: knxTraceHook("preValidation"),
      preHandler: knxTraceHook("preHandler"),
    },
    async (req, reply) => {
    // ponytail: diagnostic timing only, to pin down the 111s-hang report against real
    // production data — remove once the live bottleneck is confirmed and fixed for good.
    const t0 = Date.now();
    // § Live investigation — a real stuck request (93s) produced ZERO "knx queue/job
    // timing" log lines, not even "authenticate". That leaves two very different
    // possibilities indistinguishable without this line: (a) Fastify itself is still
    // blocked receiving/parsing the large JSON body and hasn't invoked this handler at
    // all yet, or (b) the handler started immediately and authenticate() itself is what
    // hangs. This fires the instant the handler function body starts executing, before
    // ANY other work — if THIS is also missing from the log on the next stuck attempt,
    // the bottleneck is conclusively before/outside this route's own code (Fastify body
    // parsing, or something upstream of it), not inside authenticate()/enforce().
    req.log.info({ elapsedMs: 0, stage: "handler_entered", contentLength: req.headers["content-length"] }, "knx queue/job timing");
    try {
      const user = await authenticate(ctx, req);
      req.log.info({ elapsedMs: Date.now() - t0, stage: "authenticate" }, "knx queue/job timing");
      await enforce(ctx, user, "device", null, "create");
      req.log.info({ elapsedMs: Date.now() - t0, stage: "enforce" }, "knx queue/job timing");

      // § Native file upload (fixes a real browser-extension-vs-giant-base64-JSON
      // interference bug: the same request succeeded via curl/Node but hung in the
      // user's normal Chrome profile, and succeeded instantly in Incognito — pointing at
      // an extension mangling the huge JSON `fetch()` body). The `.knxproj` FILE now
      // travels as a real `multipart/form-data` part instead of a base64 JSON field,
      // which also removes the client-side base64-encode step entirely. The `content`
      // (pasted text) and `ets` (structured array) paths are untouched — still plain JSON.
      let etsSource: { kind: "text"; content: string } | { kind: "knxproj"; base64: string; password?: string } | undefined;
      let ets: { id: string; name: string; room?: string | null; description?: string | null }[] | undefined;
      let gateway: { host: string; port?: number } | undefined;

      if (req.isMultipart()) {
        let password: string | undefined;
        try {
          for await (const part of req.parts()) {
            if (part.type === "file" && part.fieldname === "knxproj") {
              const buffer = await part.toBuffer();
              etsSource = { kind: "knxproj", base64: buffer.toString("base64"), password };
            } else if (part.type === "field" && part.fieldname === "password" && typeof part.value === "string") {
              password = part.value;
              if (etsSource?.kind === "knxproj") etsSource.password = password;
            }
          }
        } catch (err) {
          // @fastify/multipart's own oversized-file error carries statusCode 413 but isn't
          // a SupremeError, so sendError() would otherwise flatten it to a generic 500 —
          // the client needs a real 4xx to tell "your file is too big" from "we broke".
          if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE") {
            throw new SupremeError("validation_failed", "the .knxproj file exceeds the 64MB upload limit");
          }
          throw err;
        }
      } else {
        const body = req.body as {
          ets?: unknown;
          gateway?: { host?: unknown; port?: unknown };
          content?: unknown;
          knxproj?: unknown;
          password?: unknown;
        } | undefined;
        ets = Array.isArray(body?.ets) ? (body!.ets as { id: string; name: string; room?: string | null; description?: string | null }[]) : undefined;
        gateway = typeof body?.gateway?.host === "string"
          ? { host: body.gateway.host, port: typeof body.gateway.port === "number" ? body.gateway.port : undefined }
          : undefined;
        etsSource = typeof body?.knxproj === "string" && body.knxproj.length > 0
          ? { kind: "knxproj" as const, base64: body.knxproj, password: typeof body.password === "string" ? body.password : undefined }
          : typeof body?.content === "string" && body.content.length > 0
            ? { kind: "text" as const, content: body.content }
            : undefined;
      }
      req.log.info({ elapsedMs: Date.now() - t0, stage: "body_destructured", base64Bytes: etsSource?.kind === "knxproj" ? etsSource.base64.length : undefined }, "knx queue/job timing");
      const job = i().startKnxImportJob({ ets, gateway, etsSource }, req.log);
      req.log.info({ elapsedMs: Date.now() - t0, stage: "startKnxImportJob_returned", jobId: job.jobId }, "knx queue/job timing");
      reply.code(202).send({ jobId: job.jobId, status: job.status, stage: job.stage });
    } catch (err) {
      sendError(reply, err);
    }
    },
  );

  app.get("/v1/commissioning/knx/queue/job/:jobId", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "view");
      const { jobId } = req.params as { jobId: string };
      const job = i().getKnxImportJob(jobId);
      if (!job) throw new SupremeError("not_found", "no import job with that id (never started, or this gateway restarted since)");
      reply.send(job);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § Chunked KNX upload (§ live-confirmed fix — see InstallerServices
  // .startKnxChunkedUpload's own doc comment) — an alternative to the single-shot
  // multipart upload above for a large `.knxproj` over a real, measured-slow/lossy
  // connection: the browser splits the file client-side and sends each piece as its
  // own small request, retrying only the failed piece rather than the whole transfer.
  app.post("/v1/commissioning/knx/upload/init", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { totalChunks?: unknown } | undefined;
      const totalChunks = typeof body?.totalChunks === "number" ? body.totalChunks : NaN;
      if (!Number.isInteger(totalChunks) || totalChunks < 1) {
        throw new SupremeError("validation_failed", "provide a positive integer `totalChunks`");
      }
      const started = i().startKnxChunkedUpload(totalChunks);
      reply.code(201).send(started);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/knx/upload/:uploadId/chunk/:index", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { uploadId, index } = req.params as { uploadId: string; index: string };
      const i10 = Number(index);
      if (!Number.isInteger(i10) || i10 < 0) throw new SupremeError("validation_failed", "chunk index must be a non-negative integer");
      if (!Buffer.isBuffer(req.body)) throw new SupremeError("validation_failed", "chunk body must be raw binary (application/octet-stream)");
      i().receiveKnxUploadChunk(uploadId, i10, req.body);
      reply.code(204).send();
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/knx/upload/:uploadId/complete", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { uploadId } = req.params as { uploadId: string };
      const body = req.body as { password?: unknown } | undefined;
      const password = typeof body?.password === "string" ? body.password : undefined;
      const job = i().completeKnxChunkedUpload(uploadId, password, req.log);
      reply.code(202).send({ jobId: job.jobId, status: job.status, stage: job.stage });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/commissioning/knx/queue/job/:jobId/cancel", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const { jobId } = req.params as { jobId: string };
      const cancelled = i().cancelKnxImportJob(jobId);
      if (!cancelled) throw new SupremeError("conflict", "job is already finished (or does not exist) — nothing to cancel");
      reply.send({ jobId, status: "cancelled" });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Single-action approval: commission + bind every plan-supplied capability + validate,
  // rolling back automatically on any binding/validation failure (§ Rollback Flow).
  app.post("/v1/commissioning/knx/approve", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const body = req.body as { device?: UnifiedKnxDevice; name?: string; roomId?: string; roomNameHint?: string; plans?: BindingPlanItem[]; force?: boolean; shadingKind?: string };
      if (!body.device || typeof body.name !== "string" || !Array.isArray(body.plans)) {
        throw new SupremeError("validation_failed", "provide `device`, `name`, and `plans` from a prior queue response — `roomId` is optional, the Room Assignment Engine finds-or-creates a room when omitted");
      }
      const result = await i().approveKnxDevice({
        device: body.device,
        name: body.name,
        roomId: typeof body.roomId === "string" && body.roomId.length > 0 ? (body.roomId as RoomId) : undefined,
        roomNameHint: typeof body.roomNameHint === "string" ? body.roomNameHint : undefined,
        plans: body.plans,
        force: body.force === true,
        ...(body.shadingKind === "updown" || body.shadingKind === "openclose" ? { shadingKind: body.shadingKind } : {}),
      });
      reply.code(201).send(result);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Auto-commission a live native bus (e.g. Casambi): discover → create rooms from the bus's
  // group names → commission + bind every device in one step.
  app.post("/v1/commissioning/auto", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const protocol = (req.body as { protocol?: unknown })?.protocol;
      if (typeof protocol !== "string" || !protocol) {
        throw new SupremeError("validation_failed", "provide the native `protocol` to auto-commission");
      }
      reply.code(201).send(await i().autoCommission(protocol));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // §Automatic Room Assignment / §Automatic Zone Generation (Universal AV Driver SDK):
  // auto-commission AVR/HEOS/Yamaha discoveries through the confidence-based Room
  // Assignment Engine — never the bare "raw.room string" path /commissioning/auto uses.
  app.post("/v1/commissioning/auto-media", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const protocol = (req.body as { protocol?: unknown })?.protocol;
      if (protocol !== "avr" && protocol !== "heos" && protocol !== "yamaha") {
        throw new SupremeError("validation_failed", "protocol must be one of: avr, heos, yamaha");
      }
      reply.code(201).send(await i().autoCommissionMedia(protocol));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // KNXnet/IP interface discovery — find gateways on the LAN to configure the KNX driver host/port.
  app.get("/v1/commissioning/knx/interfaces", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      reply.send({ interfaces: await i().discoverKnxInterfaces() });
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Native protocol bindings (§3) ────────────────────────────────────────────
  app.post("/v1/commissioning/bind", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "create");
      const input = BindProtocolRequest.parse(req.body);
      const binding = await i().bindProtocol({
        deviceId: input.deviceId as DeviceId,
        capability: input.capability as CapabilityKind,
        protocol: input.protocol,
        address: input.address,
        config: input.config,
      });
      reply.code(201).send({ binding });
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get("/v1/commissioning/bindings", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const body: ProtocolBindingList = { bindings: await i().listProtocolBindings() };
      reply.send(body);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // § live-confirmed fix — bulk cleanup for bindings orphaned before removeProtocolBindings
  // existed (every device deleted before that fix left its bindings behind). Same
  // installer:delete permission as a device delete, since this is destructive cleanup of
  // real binding state, not a read.
  app.post("/v1/commissioning/bindings/cleanup-orphaned", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "device", null, "delete");
      reply.send(await i().cleanupOrphanedProtocolBindings());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Diagnostics ──────────────────────────────────────────────────────────────
  app.get("/v1/diagnostics", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().diagnostics()) satisfies DiagnosticsReport);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Real host telemetry (§ Installer Dashboard): CPU / memory / temperature / storage / uptime read
  // straight from the OS. Metrics with no source on this platform are omitted, never faked.
  app.get("/v1/system/health", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(await collectSystemHealth());
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Software-update status (§ Update Center). Checks the signed OTA channel if one is configured;
  // otherwise honestly reports the current version with channelConfigured=false. Detection only —
  // the OS updater applies verified releases (staged + rollback-safe).
  app.get("/v1/system/update", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      const cfg = ctx.config;
      const checkedAt = new Date().toISOString();
      if (!cfg.otaUrl || !cfg.otaPublicKey) {
        reply.send({ current: cfg.hubVersion, channelConfigured: false, updateAvailable: false, checkedAt } satisfies SystemUpdate);
        return;
      }
      try {
        const result = await new OtaChecker({ url: cfg.otaUrl, publicKeyPem: cfg.otaPublicKey, currentVersion: cfg.hubVersion }).check();
        reply.send({
          current: result.current,
          channelConfigured: true,
          updateAvailable: result.updateAvailable,
          ...(result.latest ? { latest: { version: result.latest.version, notes: result.latest.notes, releasedAt: result.latest.releasedAt } } : {}),
          checkedAt,
        } satisfies SystemUpdate);
      } catch (e) {
        reply.send({ current: cfg.hubVersion, channelConfigured: true, updateAvailable: false, checkedAt, error: e instanceof Error ? e.message : "update check failed" } satisfies SystemUpdate);
      }
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Project export ───────────────────────────────────────────────────────────
  app.get("/v1/project/export", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().projectExport()) satisfies ProjectExport);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Backup / restore ─────────────────────────────────────────────────────────
  app.post("/v1/backup", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send(await i().createBackup());
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/backup/restore", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const { document, dryRun } = RestoreRequest.parse(req.body);
      // Dry-run previews what would be restored (and verifies the signature) without touching data.
      if (dryRun) {
        reply.send({ inspection: i().inspectRestore(document) });
        return;
      }
      reply.send(await i().restore(document));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup history (metadata only) + re-download by id.
  app.get("/v1/backup/list", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send({ backups: await i().listBackups() } satisfies BackupList);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/v1/backup/:id", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      reply.send(await i().getBackupDocument(req.params.id));
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup health indicator: last backup, next due, retention, last restore.
  app.get("/v1/backup/status", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send((await i().backupStatus()) satisfies BackupStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Backup schedule (automatic backups on the hub tick).
  app.get("/v1/backup/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send({ schedule: await i().getBackupSchedule() } satisfies BackupScheduleResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.put("/v1/backup/schedule", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const input = BackupScheduleInput.parse(req.body);
      reply.send({ schedule: await i().setBackupSchedule(input) } satisfies BackupScheduleResponse);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // ── Licensing ────────────────────────────────────────────────────────────────
  app.get("/v1/license", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "view");
      reply.send(i().licenseStatus() satisfies LicenseStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  app.post("/v1/license/activate", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const { token } = ActivateLicenseRequest.parse(req.body);
      await i().activateLicense(token);
      reply.send(i().licenseStatus() satisfies LicenseStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Toggle Developer Mode at runtime (unlocks every SKU + feature). Blocked in production builds —
  // the developer license can never be used in production. Admin/installer/master only.
  app.post<{ Body: { enabled?: boolean } }>("/v1/license/dev-mode", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      if (ctx.config.devModeLocked) throw new SupremeError("forbidden", "Developer Mode is locked on this build (SUPREME_DEV_MODE_LOCKED)");
      await i().setDevMode(Boolean(req.body?.enabled));
      reply.send(i().licenseStatus() satisfies LicenseStatus);
    } catch (err) {
      sendError(reply, err);
    }
  });

  // Dev-only license issuance (no cloud licensing key configured).
  app.post("/v1/license/dev-issue", async (req, reply) => {
    try {
      const user = await authenticate(ctx, req);
      await enforce(ctx, user, "integration", null, "admin");
      const body = (req.body ?? {}) as { sku?: string; seats?: number; features?: string[] };
      const token = i().devIssueLicense({
        sku: body.sku ?? "estate",
        seats: body.seats ?? 10,
        features: body.features ?? [],
      });
      reply.code(201).send({ token });
    } catch (err) {
      sendError(reply, err);
    }
  });
}
