import { TunnelBroker } from "@supreme/tunnel-broker";
import { BrokerHubRouter } from "./hub-router.js";
import { OAuthProvider, type OAuthClient } from "./oauth.js";
import { buildVoiceServer } from "./server.js";

/**
 * Cloud Voice service entry point (blueprint §9). OPTIONAL cloud infrastructure — the hub controls
 * devices locally without it; this only adds Alexa/Google voice. Configuration:
 *   VOICE_SIGNING_SECRET   HMAC secret for OAuth tokens (REQUIRED in production).
 *   VOICE_CLIENTS          `clientId:secret:assistant:redirectUri` entries, comma-separated.
 *   VOICE_PORT             listen port (default 8095).
 *
 * The broker + home→hub resolver + Identity-plane authentication are wired by the cloud deployment;
 * here we boot with the broker core and env-configured clients. authenticateUser MUST be replaced
 * with a real Identity-plane call before production (the default refuses all logins).
 */
function parseClients(raw: string): OAuthClient[] {
  const clients: OAuthClient[] = [];
  for (const entry of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    // Split on the FIRST three colons only — the redirect URI (which contains "://") is the rest,
    // so a normal https URL survives intact.
    const parts = entry.split(":");
    const clientId = parts[0];
    const clientSecret = parts[1];
    const assistant = parts[2];
    const redirectUri = parts.slice(3).join(":");
    if (clientId && clientSecret && (assistant === "alexa" || assistant === "google") && redirectUri) {
      const existing = clients.find((c) => c.clientId === clientId);
      if (existing) existing.redirectUris.push(redirectUri);
      else clients.push({ clientId, clientSecret, assistant, redirectUris: [redirectUri] });
    }
  }
  return clients;
}

async function main(): Promise<void> {
  const signingSecret = process.env.VOICE_SIGNING_SECRET;
  if (!signingSecret) throw new Error("VOICE_SIGNING_SECRET is required");
  const clients = parseClients(process.env.VOICE_CLIENTS ?? "");
  const oauth = new OAuthProvider({ signingSecret, clients });

  const broker = new TunnelBroker({ caPublicKey: process.env.VOICE_BROKER_CA_PUBKEY ?? "" });
  // home→hub resolution is owned by the connectivity plane; until wired, hubId === homeId.
  const hub = new BrokerHubRouter({ broker, resolveHubId: (homeId) => homeId });

  // Per-hub keys for proactive state-report ingest: "key1:home1,key2:home2".
  const hubKeys = new Map<string, string>();
  for (const pair of (process.env.VOICE_HUB_KEYS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf(":");
    if (i > 0) hubKeys.set(pair.slice(0, i), pair.slice(i + 1));
  }

  const app = buildVoiceServer({
    oauth,
    hub,
    hubKeys,
    // Placeholder: production injects the Identity plane. Refuse all logins so a misconfigured
    // deploy can't silently link accounts. The default notifier logs and drops — wire a real
    // AssistantNotifier (Alexa event gateway via LWA + Google HomeGraph via a service account)
    // before proactive reports actually reach the assistants.
    authenticateUser: async () => null,
    logLevel: process.env.VOICE_LOG_LEVEL ?? "info",
  });
  const port = Number(process.env.VOICE_PORT ?? 8095);
  await app.listen({ host: "0.0.0.0", port });
}

main().catch((err) => {
  console.error("fatal: voice service failed to start", err);
  process.exit(1);
});
