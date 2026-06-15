/**
 * Cloud push dispatch (§13). The hub forwards a notification + device token here; the
 * cloud holds the FCM/APNs/WebPush credentials and does the actual platform delivery,
 * so the hub never needs provider secrets. Providers are seams: FCM (HTTP v1) and
 * WebPush ship real but credential-injected (so they're testable + safe by default);
 * the dispatcher routes by platform and is tolerant of a single provider failing.
 */
export interface RelayPushPayload {
  platform: string;
  token: string;
  message: { title: string; body: string; level: string; data?: Record<string, string> };
}

export interface IRelayPushProvider {
  readonly platform: string;
  deliver(payload: RelayPushPayload): Promise<void>;
}

/**
 * FCM HTTP v1 provider. The OAuth2 access token (from a service account) is injected —
 * a real deployment signs a short-lived JWT and exchanges it; tests inject a stub. The
 * message POST itself is exercised via the injected fetch.
 */
export interface FcmProviderOptions {
  projectId: string;
  getAccessToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}
export class FcmProvider implements IRelayPushProvider {
  readonly platform = "fcm";
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly opts: FcmProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }
  async deliver(payload: RelayPushPayload): Promise<void> {
    const accessToken = await this.opts.getAccessToken();
    const res = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${this.opts.projectId}/messages:send`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({
          message: {
            token: payload.token,
            notification: { title: payload.message.title, body: payload.message.body },
            data: payload.message.data ?? {},
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`fcm ${res.status}`);
  }
}

/** WebPush (VAPID) provider. The `send` primitive is injected (the real impl wraps the
 * `web-push` library); tests pass a fake. */
export interface WebPushProviderOptions {
  send: (token: string, body: string) => Promise<void>;
}
export class WebPushProvider implements IRelayPushProvider {
  readonly platform = "webpush";
  constructor(private readonly opts: WebPushProviderOptions) {}
  async deliver(payload: RelayPushPayload): Promise<void> {
    await this.opts.send(payload.token, JSON.stringify(payload.message));
  }
}

export class PushDispatcher {
  private readonly byPlatform = new Map<string, IRelayPushProvider>();
  constructor(providers: IRelayPushProvider[] = []) {
    for (const p of providers) this.byPlatform.set(p.platform, p);
  }
  get configuredPlatforms(): string[] {
    return [...this.byPlatform.keys()];
  }
  /** Deliver to the provider for the payload's platform. Returns false if none handles it. */
  async dispatch(payload: RelayPushPayload): Promise<boolean> {
    const provider = this.byPlatform.get(payload.platform);
    if (!provider) return false;
    await provider.deliver(payload);
    return true;
  }
}
