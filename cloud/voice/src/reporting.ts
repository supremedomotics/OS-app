import { randomUUID } from "node:crypto";
import { alexaPropertyFor } from "./alexa.js";
import { googleStateFragment } from "./google.js";
import type { Assistant } from "./index.js";
import type { LinkRecord } from "./oauth.js";

/**
 * Proactive state reporting (blueprint §9, ADR 0010): when a device changes locally on the hub
 * (e.g. someone flips a physical switch), the assistants must be told asynchronously so "is the
 * light on?" and routines stay correct. The hub posts a state delta to the cloud; the cloud
 * translates it into each linked assistant's proactive event and dispatches it.
 *
 * Payload construction here is pure + testable. The actual dispatch to the assistant clouds — the
 * Alexa event gateway (needs an LWA token from the AcceptGrant code) and Google HomeGraph
 * ReportState (needs a service-account JWT) — lives behind the AssistantNotifier seam, which is the
 * credential boundary (a logging no-op until those creds are provisioned).
 */

/** A normalized device-state change from the hub. `state` is the Supreme capability state object. */
export interface StateDelta {
  deviceId: string;
  capability: string;
  state: Record<string, unknown>;
}

export interface AssistantReport {
  assistant: Assistant;
  payload: unknown;
}

export interface AssistantNotifier {
  /** Dispatch a proactive report to the assistant's event endpoint. */
  notify(report: AssistantReport, link: LinkRecord): Promise<void>;
}

/** Default notifier: logs and drops. Real dispatch requires Alexa LWA / Google service-account creds. */
export class LoggingNotifier implements AssistantNotifier {
  constructor(private readonly log?: (msg: string, meta?: Record<string, unknown>) => void) {}
  async notify(report: AssistantReport): Promise<void> {
    this.log?.("proactive report (not dispatched — notifier credentials not configured)", { assistant: report.assistant });
  }
}

/**
 * Alexa ChangeReport envelope. The endpoint.scope token is intentionally omitted here — the
 * notifier injects the event-gateway token it obtains by exchanging the link's AcceptGrant code.
 */
export function buildAlexaChangeReport(delta: StateDelta, nowIso: string): unknown | null {
  const prop = alexaPropertyFor(delta.capability, delta.state, nowIso);
  if (!prop) return null;
  return {
    event: {
      header: { namespace: "Alexa", name: "ChangeReport", payloadVersion: "3", messageId: randomUUID() },
      endpoint: { endpointId: delta.deviceId },
      payload: { change: { cause: { type: "PHYSICAL_INTERACTION" }, properties: [prop] } },
    },
    context: { properties: [] },
  };
}

/** Google HomeGraph ReportState request body. agentUserId is the linked Supreme account. */
export function buildGoogleReportState(link: LinkRecord, delta: StateDelta): unknown | null {
  const fragment = googleStateFragment(delta.capability, delta.state);
  if (!fragment) return null;
  return {
    requestId: randomUUID(),
    agentUserId: link.accountId,
    payload: { devices: { states: { [delta.deviceId]: { online: true, ...fragment } } } },
  };
}

/**
 * Fan a hub state delta out to every linked assistant for the home. Returns how many reports were
 * dispatched (capabilities an assistant can't represent are skipped). Dispatch failures are isolated
 * per assistant so one bad endpoint can't block the others.
 */
export async function dispatchStateDelta(opts: {
  links: LinkRecord[];
  delta: StateDelta;
  notifier: AssistantNotifier;
  nowIso: string;
}): Promise<number> {
  let delivered = 0;
  for (const link of opts.links) {
    const payload =
      link.assistant === "alexa"
        ? buildAlexaChangeReport(opts.delta, opts.nowIso)
        : link.assistant === "google"
          ? buildGoogleReportState(link, opts.delta)
          : null;
    if (!payload) continue;
    try {
      await opts.notifier.notify({ assistant: link.assistant, payload }, link);
      delivered += 1;
    } catch {
      // Per-assistant isolation — a failed dispatch must not block the rest.
    }
  }
  return delivered;
}
