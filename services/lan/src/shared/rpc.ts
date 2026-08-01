import { randomUUID } from "node:crypto";
import type { IEventBus, Subscription } from "@supreme/messaging";

/**
 * Generic request/reply built ONLY on `IEventBus.publish`/`subscribe` (§ Production Architecture
 * Refactor). `@supreme/messaging`'s `IEventBus` is pub/sub only — no request/reply primitive —
 * and this deliberately does not add one to that package: every caller (both the Gateway-side
 * transport clients and `supreme-lan`'s own command handlers) gets real RPC semantics without
 * `@supreme/messaging` needing to know anything about it. Reused by every command in
 * `wire-types.ts` (bind/send/close/health), and reusable by any future command this service adds.
 */
export interface RequestPayload {
  replySubject: string;
}

export async function requestReply<TReq extends RequestPayload, TRes>(
  bus: IEventBus,
  subject: string,
  payload: Omit<TReq, "replySubject">,
  opts: { timeoutMs?: number } = {},
): Promise<TRes> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const replySubject = `${subject}.reply.${randomUUID()}`;

  return new Promise<TRes>((resolve, reject) => {
    let settled = false;
    let subscription: Subscription | null = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      subscription?.unsubscribe();
      reject(new Error(`supreme-lan: request to "${subject}" timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    bus
      .subscribe<TRes>(replySubject, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        subscription?.unsubscribe();
        resolve(response);
      })
      .then((sub) => {
        subscription = sub;
        // The subscription is guaranteed active before the request is published — no race
        // between "publish" and "start listening for the reply."
        return bus.publish(subject, { ...payload, replySubject } as unknown as TReq);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Server-side helper: wraps a request handler so every subscriber on `subject` automatically
 * replies on the request's own `replySubject` — the mirror image of {@link requestReply}. A
 * handler that throws still gets a reply (`onError`), so a caller's `requestReply` never hangs
 * until timeout on a real server-side failure.
 */
export function handleRequests<TReq extends RequestPayload, TRes>(
  bus: IEventBus,
  subject: string,
  handler: (payload: TReq) => Promise<TRes>,
  onError: (err: Error) => TRes,
): Promise<Subscription> {
  return bus.subscribe<TReq>(subject, (payload) => {
    void handler(payload)
      .then((res) => bus.publish(payload.replySubject, res))
      .catch((err) => bus.publish(payload.replySubject, onError(err instanceof Error ? err : new Error(String(err)))));
  });
}
