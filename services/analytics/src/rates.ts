/**
 * Electricity rate resolution (§16). The homeowner sets their country, city, and electricity
 * provider; from that we resolve a per-kWh rate + currency to price consumption. Resolution order:
 *   1. an explicit manual `ratePerKwh` (the owner read it off their bill) — most accurate;
 *   2. a live provider-rate lookup (the `RateFetcher` seam — a tariff/provider API wired at the hub
 *      edge; not bundled, since there's no universal free rate API);
 *   3. a curated country default (typical residential rate) — works fully offline.
 * The curated table holds approximate residential rates in local currency; treat as a sensible
 * default to be confirmed against the bill, not a billing-grade source.
 */

export interface ElectricityRate {
  currency: string;
  /** Approximate residential rate per kWh, in the currency above. */
  ratePerKwh: number;
}

/** ISO 3166-1 alpha-2 country code → typical residential electricity rate. */
export const COUNTRY_RATES: Record<string, ElectricityRate> = {
  IN: { currency: "INR", ratePerKwh: 8.0 },
  US: { currency: "USD", ratePerKwh: 0.17 },
  GB: { currency: "GBP", ratePerKwh: 0.28 },
  DE: { currency: "EUR", ratePerKwh: 0.4 },
  FR: { currency: "EUR", ratePerKwh: 0.25 },
  ES: { currency: "EUR", ratePerKwh: 0.24 },
  IT: { currency: "EUR", ratePerKwh: 0.36 },
  NL: { currency: "EUR", ratePerKwh: 0.35 },
  IE: { currency: "EUR", ratePerKwh: 0.33 },
  AE: { currency: "AED", ratePerKwh: 0.38 },
  SA: { currency: "SAR", ratePerKwh: 0.18 },
  AU: { currency: "AUD", ratePerKwh: 0.3 },
  NZ: { currency: "NZD", ratePerKwh: 0.29 },
  CA: { currency: "CAD", ratePerKwh: 0.15 },
  JP: { currency: "JPY", ratePerKwh: 31 },
  SG: { currency: "SGD", ratePerKwh: 0.3 },
  ZA: { currency: "ZAR", ratePerKwh: 2.5 },
  BR: { currency: "BRL", ratePerKwh: 0.85 },
  MX: { currency: "MXN", ratePerKwh: 2.0 },
  CN: { currency: "CNY", ratePerKwh: 0.55 },
  KR: { currency: "KRW", ratePerKwh: 130 },
  CH: { currency: "CHF", ratePerKwh: 0.27 },
  SE: { currency: "SEK", ratePerKwh: 1.5 },
  PL: { currency: "PLN", ratePerKwh: 0.85 },
  PT: { currency: "EUR", ratePerKwh: 0.22 },
  BE: { currency: "EUR", ratePerKwh: 0.34 },
  AT: { currency: "EUR", ratePerKwh: 0.25 },
};

export interface ProviderQuery {
  /** ISO 3166-1 alpha-2 country code (e.g. "IN", "US"). */
  country: string;
  city?: string;
  provider?: string;
  /** Explicit rate from the bill (overrides the table/live lookup). */
  ratePerKwh?: number;
  /** Currency override (otherwise derived from the country). */
  currency?: string;
}

export interface ResolvedRate {
  currency: string;
  ratePerKwh: number;
  source: "manual" | "provider" | "country-default";
  country: string;
  city: string | null;
  provider: string | null;
}

export class RateError extends Error {}

/** A live provider/tariff lookup (wired at the hub edge). Returns null if it has no rate. */
export type RateFetcher = (q: ProviderQuery) => Promise<ElectricityRate | null>;

/**
 * Resolve a per-kWh rate. Synchronous core (manual override → country default). When a country isn't
 * in the table and no manual rate is given, throws — the caller should prompt for the rate. Use
 * {@link resolveRateAsync} to additionally try a live provider lookup.
 */
export function resolveRate(q: ProviderQuery): ResolvedRate {
  const cc = q.country?.toUpperCase();
  if (!cc || cc.length !== 2) throw new RateError("country must be an ISO 3166-1 alpha-2 code");
  if (q.ratePerKwh !== undefined) {
    if (!Number.isFinite(q.ratePerKwh) || q.ratePerKwh < 0) throw new RateError("ratePerKwh must be a non-negative number");
    return { currency: q.currency ?? COUNTRY_RATES[cc]?.currency ?? "USD", ratePerKwh: q.ratePerKwh, source: "manual", country: cc, city: q.city ?? null, provider: q.provider ?? null };
  }
  const def = COUNTRY_RATES[cc];
  if (!def) throw new RateError(`no default rate for country ${cc} — provide ratePerKwh from your bill`);
  return { currency: q.currency ?? def.currency, ratePerKwh: def.ratePerKwh, source: "country-default", country: cc, city: q.city ?? null, provider: q.provider ?? null };
}

/** Resolve a rate, trying a live provider lookup before the country default (manual still wins). */
export async function resolveRateAsync(q: ProviderQuery, fetcher?: RateFetcher): Promise<ResolvedRate> {
  if (q.ratePerKwh !== undefined || !fetcher) return resolveRate(q);
  try {
    const live = await fetcher(q);
    if (live) {
      const cc = q.country.toUpperCase();
      return { currency: q.currency ?? live.currency, ratePerKwh: live.ratePerKwh, source: "provider", country: cc, city: q.city ?? null, provider: q.provider ?? null };
    }
  } catch {
    // fall through to the offline default
  }
  return resolveRate(q);
}
