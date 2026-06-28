import { describe, expect, it } from "vitest";
import { buildAlexaChangeReport, buildGoogleReportState, dispatchStateDelta, type AssistantNotifier, type AssistantReport, type StateDelta } from "./reporting.js";
import type { LinkRecord } from "./oauth.js";

const link = (assistant: "alexa" | "google"): LinkRecord => ({
  linkId: `lnk-${assistant}`,
  assistant,
  clientId: `${assistant}-client`,
  refreshGen: 0,
  accountId: "acct-1",
  homeId: "home-1",
  hubToken: "ht",
  scopes: ["control"],
  linkedAt: 0,
});

describe("proactive report builders", () => {
  it("builds an Alexa ChangeReport for an onoff change (no scope token — notifier adds it)", () => {
    const r = buildAlexaChangeReport({ deviceId: "d1", capability: "onoff", state: { on: true } }, "2026-01-01T00:00:00Z") as any;
    expect(r.event.header.name).toBe("ChangeReport");
    expect(r.event.endpoint.endpointId).toBe("d1");
    expect(r.event.endpoint.scope).toBeUndefined();
    expect(r.event.payload.change.properties[0]).toMatchObject({ namespace: "Alexa.PowerController", name: "powerState", value: "ON" });
  });

  it("builds a Google ReportState for a brightness change", () => {
    const r = buildGoogleReportState(link("google"), { deviceId: "d2", capability: "brightness", state: { level: 55 } }) as any;
    expect(r.agentUserId).toBe("acct-1");
    expect(r.payload.devices.states.d2).toMatchObject({ online: true, brightness: 55 });
  });

  it("returns null for a capability the assistant can't represent", () => {
    expect(buildAlexaChangeReport({ deviceId: "d", capability: "media", state: {} }, "t")).toBeNull();
    expect(buildGoogleReportState(link("google"), { deviceId: "d", capability: "media", state: {} })).toBeNull();
  });
});

describe("dispatchStateDelta", () => {
  class CapturingNotifier implements AssistantNotifier {
    sent: AssistantReport[] = [];
    async notify(report: AssistantReport) {
      this.sent.push(report);
    }
  }

  it("fans one delta out to every linked assistant for the home", async () => {
    const notifier = new CapturingNotifier();
    const delta: StateDelta = { deviceId: "d1", capability: "lock", state: { locked: true } };
    const delivered = await dispatchStateDelta({ links: [link("alexa"), link("google")], delta, notifier, nowIso: "t" });
    expect(delivered).toBe(2);
    expect(notifier.sent.map((s) => s.assistant).sort()).toEqual(["alexa", "google"]);
  });

  it("isolates a failing assistant dispatch from the others", async () => {
    const flaky: AssistantNotifier = {
      notify: async (r) => {
        if (r.assistant === "alexa") throw new Error("event gateway 500");
      },
    };
    const delta: StateDelta = { deviceId: "d1", capability: "onoff", state: { on: false } };
    const delivered = await dispatchStateDelta({ links: [link("alexa"), link("google")], delta, notifier: flaky, nowIso: "t" });
    expect(delivered).toBe(1); // google still delivered
  });
});
