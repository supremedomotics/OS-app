import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { provisionHaToken, haHttpFromWsUrl } from "./ha-provisioner.js";

/**
 * A fake Home Assistant exposing just enough of the onboarding + auth + WS surface to
 * prove the provisioner end-to-end with no real HA:
 *   GET  /api/onboarding            → steps (user not done until created)
 *   POST /api/onboarding/users      → { auth_code }
 *   POST /auth/token                → { access_token }
 *   POST /api/onboarding/*          → 200 (best-effort steps)
 *   WS   /api/websocket             → auth handshake + auth/long_lived_access_token
 */
function fakeHa(opts: { llt: string; userAlreadyDone?: boolean }) {
  const created = { user: Boolean(opts.userAlreadyDone), got: {} as Record<string, unknown> };
  const http: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const send = (code: number, obj: unknown) => {
        res.statusCode = code;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(obj));
      };
      if (req.method === "GET" && req.url === "/api/onboarding") {
        return send(200, [
          { step: "user", done: created.user },
          { step: "core_config", done: false },
        ]);
      }
      if (req.method === "POST" && req.url === "/api/onboarding/users") {
        created.user = true;
        created.got.user = JSON.parse(body);
        return send(200, { auth_code: "code-123" });
      }
      if (req.method === "POST" && req.url === "/auth/token") {
        created.got.token = body;
        return send(200, { access_token: "access-abc", token_type: "Bearer", expires_in: 1800 });
      }
      if (req.method === "POST" && req.url?.startsWith("/api/onboarding/")) {
        return send(200, {});
      }
      send(404, { error: "not found" });
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    if (req.url?.startsWith("/api/websocket")) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws));
    } else socket.destroy();
  });
  wss.on("connection", (ws: WebSocket) => {
    ws.send(JSON.stringify({ type: "auth_required" }));
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === "auth") {
        ws.send(JSON.stringify(msg.access_token === "access-abc" ? { type: "auth_ok" } : { type: "auth_invalid" }));
      } else if (msg.type === "auth/long_lived_access_token") {
        created.got.llt = { client_name: msg.client_name, lifespan: msg.lifespan };
        ws.send(JSON.stringify({ id: msg.id, type: "result", success: true, result: opts.llt }));
      }
    });
  });
  return new Promise<{ http: Server; wss: WebSocketServer; port: number; created: typeof created }>((resolve) => {
    http.listen(0, "127.0.0.1", () => resolve({ http, wss, port: (http.address() as AddressInfo).port, created }));
  });
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
});

describe("HA provisioner (against a fake HA)", () => {
  it("derives the HTTP base from the WS URL", () => {
    expect(haHttpFromWsUrl("ws://homeassistant:8123/api/websocket")).toBe("http://homeassistant:8123");
  });

  it("onboards HA headlessly and mints a long-lived token", async () => {
    const ha = await fakeHa({ llt: "llt-xyz" });
    cleanup = () => {
      ha.wss.close();
      ha.http.close();
    };
    const base = `127.0.0.1:${ha.port}`;
    const result = await provisionHaToken({
      httpUrl: `http://${base}`,
      wsUrl: `ws://${base}/api/websocket`,
      adminUsername: "admin",
      adminPassword: "admin@supremeos",
      systemName: "Penthouse",
      timeZone: "Europe/London",
    });
    expect(result).toEqual({ token: "llt-xyz", created: true });
    // The hidden internal account was created with the configured credentials.
    expect((ha.created.got.user as { username: string }).username).toBe("admin");
    expect((ha.created.got.llt as { client_name: string }).client_name).toContain("Penthouse");
  });

  it("returns null when HA already has an owner (don't create a second)", async () => {
    const ha = await fakeHa({ llt: "llt-xyz", userAlreadyDone: true });
    cleanup = () => {
      ha.wss.close();
      ha.http.close();
    };
    const base = `127.0.0.1:${ha.port}`;
    const result = await provisionHaToken({
      httpUrl: `http://${base}`,
      wsUrl: `ws://${base}/api/websocket`,
      adminUsername: "admin",
      adminPassword: "admin@supremeos",
    });
    expect(result).toBeNull();
  });
});
