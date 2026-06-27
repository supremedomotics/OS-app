import { MemoryTokenStore, SupremeClient } from "@supreme/sdk";

/**
 * The single Supreme API client for the Installer Portal. The portal binds to the
 * Supreme contract only — it has no concept of Home Assistant. The hub base URL is
 * resolved from the environment (LAN-direct in the field; cloud relay when remote).
 */
const baseUrl = import.meta.env.VITE_SUPREME_API_URL ?? "http://127.0.0.1:8080";

export const client = new SupremeClient({ baseUrl, tokenStore: new MemoryTokenStore() });

/** Import an ETS group-address export (KNX) → auto-created device cards (§4). */
export async function importKnx(content: string): Promise<{
  devices: number;
  roomsCreated: number;
  created: { name: string; room: string | null; capabilities: string[] }[];
}> {
  const res = await fetch(`${baseUrl}/v1/commissioning/import/knx`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${client.accessToken ?? ""}` },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const msg = await res.json().catch(() => ({ message: `${res.status}` }));
    throw new Error((msg as { message?: string }).message ?? "Import failed");
  }
  return res.json() as Promise<{ devices: number; roomsCreated: number; created: { name: string; room: string | null; capabilities: string[] }[] }>;
}
