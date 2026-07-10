import { MemoryTokenStore, SupremeClient } from "@supreme/sdk";

/**
 * The single Supreme API client for the Installer Portal. The portal binds to the
 * Supreme contract only — it has no concept of Home Assistant. The hub base URL is
 * resolved from the environment (LAN-direct in the field; cloud relay when remote).
 */
const baseUrl = import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080";

// The SDK refreshes an expired access token silently and retries — a long commissioning session no
// longer breaks at the 15-minute access-token TTL. This only fires when the refresh token itself is
// dead (revoked / expired), i.e. the session is genuinely over.
const sessionExpiredListeners = new Set<() => void>();
export function onSessionExpired(listener: () => void): () => void {
  sessionExpiredListeners.add(listener);
  return () => sessionExpiredListeners.delete(listener);
}

export const client = new SupremeClient({
  baseUrl,
  tokenStore: new MemoryTokenStore(),
  onSessionExpired: () => { for (const l of sessionExpiredListeners) l(); },
});

export interface KnxImportResult {
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
}

async function postImport(body: Record<string, string>): Promise<KnxImportResult> {
  const res = await fetch(`${baseUrl}/v1/commissioning/import/knx`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${client.accessToken ?? ""}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ message: `${res.status}` }));
    throw new Error((msg as { message?: string }).message ?? "Import failed");
  }
  return res.json() as Promise<KnxImportResult>;
}

/** Import an ETS group-address export (CSV/XML text) → auto-created device cards (§4). */
export const importKnx = (content: string): Promise<KnxImportResult> => postImport({ content });

/**
 * Import a `.knxproj` file (base64) → device cards placed in their ETS rooms (§4).
 * `password` is required only for ETS6 password-protected projects (WinZip-AES).
 */
export const importKnxProject = (base64: string, password?: string): Promise<KnxImportResult> =>
  postImport(password ? { knxproj: base64, password } : { knxproj: base64 });
