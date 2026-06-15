import { MemoryTokenStore, SupremeClient, SupremeStream } from "@supreme/sdk";

/**
 * The single Supreme API client for the homeowner web app. The app binds to the
 * Supreme contract only — it has no concept of Home Assistant. The hub base URL is
 * resolved from the environment (LAN-direct in the home; cloud relay when remote).
 */
const baseUrl = import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080";
const wsBaseUrl = baseUrl.replace(/^http/, "ws");

export const client = new SupremeClient({ baseUrl, tokenStore: new MemoryTokenStore() });

/** Open the realtime WSS stream once authenticated (live device state + notifications). */
export function openStream(): SupremeStream | null {
  const token = client.accessToken;
  if (!token) return null;
  return new SupremeStream(wsBaseUrl, token, WebSocket as unknown as never);
}
