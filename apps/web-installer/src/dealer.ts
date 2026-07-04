/**
 * Minimal client for the OPTIONAL cloud Dealer-Licensing API (§9 commercial). Configured separately
 * from the hub (different service, dealer org API key). When unconfigured, the Dealer page shows a
 * setup hint rather than failing — the hub validates its license offline and works without it.
 */
const dealerUrl = (import.meta.env.VITE_SUPREME_DEALER_URL ?? "").replace(/\/$/, "");
const dealerKey = import.meta.env.VITE_SUPREME_DEALER_KEY ?? "";

export const dealerConfigured = Boolean(dealerUrl && dealerKey);

export type LicenseRecordStatus = "issued" | "activated" | "revoked" | "transferred";

export interface LicenseRecord {
  id: string;
  dealerOrgId: string;
  homeId: string;
  sku: string;
  features: string[];
  seats: number;
  issuedAt: string;
  expiresAt: string | null;
  status: LicenseRecordStatus;
  activatedAt: string | null;
  supersedes: string | null;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${dealerUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${dealerKey}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const msg = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(msg.message ?? `dealer request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export const listDealerLicenses = (): Promise<{ records: LicenseRecord[] }> =>
  call("/v1/dealer/licenses");

export const dealerSeatsInUse = (): Promise<{ seatsInUse: number }> => call("/v1/dealer/seats");

export interface IssueInput {
  homeId: string;
  sku: string;
  seats?: number;
  features?: string[];
  expiresAt?: string | null;
}

export const issueDealerLicense = (input: IssueInput): Promise<{ record: LicenseRecord }> =>
  call("/v1/dealer/licenses", { method: "POST", body: JSON.stringify(input) });

export const activateDealerLicense = (id: string): Promise<{ record: LicenseRecord }> =>
  call(`/v1/dealer/licenses/${id}/activate`, { method: "POST" });

export const revokeDealerLicense = (id: string): Promise<{ record: LicenseRecord }> =>
  call(`/v1/dealer/licenses/${id}/revoke`, { method: "POST" });

export const transferDealerLicense = (id: string, newHomeId: string): Promise<{ record: LicenseRecord }> =>
  call(`/v1/dealer/licenses/${id}/transfer`, { method: "POST", body: JSON.stringify({ newHomeId }) });
