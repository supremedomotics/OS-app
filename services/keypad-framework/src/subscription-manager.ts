import type { CapabilityKind, DeviceId, HomeId, KeypadSubscription, KeypadSubscriptionId } from "@supreme/domain-model";
import { newId } from "@supreme/domain-model";

/**
 * Subscription Manager (§ Universal Keypad Framework, deliverable 7).
 *
 * Example from the brief: "Living Room Light subscribed by: KNX Keypad, Casambi
 * Keypad, Lutron Keypad, Matter Switch" — when the light changes, every subscriber
 * receives the update. Indexed by device+capability so the Universal Feedback
 * Engine's fan-out is O(subscribers), never a scan of every subscription on the hub.
 */
export interface IKeypadSubscriptionStore {
  list(): Promise<KeypadSubscription[]>;
  put(subscription: KeypadSubscription): Promise<void>;
  remove(id: KeypadSubscriptionId): Promise<void>;
}

/** In-memory store (dev / non-persistent hubs) — mirrors `InMemoryAutomationStore`
 * (one hub = one home, so — like `InMemoryAutomationStore` — this doesn't bother
 * filtering by `homeId`; the field exists on the record for API-shape parity with
 * `Automation`, not because this store is multi-home). */
export class InMemoryKeypadSubscriptionStore implements IKeypadSubscriptionStore {
  private readonly subscriptions = new Map<string, KeypadSubscription>();
  async list(): Promise<KeypadSubscription[]> {
    return [...this.subscriptions.values()];
  }
  async put(subscription: KeypadSubscription): Promise<void> {
    this.subscriptions.set(subscription.id, subscription);
  }
  async remove(id: KeypadSubscriptionId): Promise<void> {
    this.subscriptions.delete(id);
  }
}

export interface CreateKeypadSubscriptionInput {
  homeId: HomeId;
  deviceId: DeviceId;
  capability: CapabilityKind;
  keypadId: DeviceId;
  control: string;
}

export class SubscriptionManager {
  /** `deviceId:capability` → the subscriptions watching it, for O(1) fan-out lookup. */
  private readonly byDevice = new Map<string, Map<KeypadSubscriptionId, KeypadSubscription>>();

  constructor(private readonly store: IKeypadSubscriptionStore) {}

  /** Load every persisted subscription into the in-memory index (boot). */
  async hydrate(): Promise<void> {
    this.byDevice.clear();
    for (const sub of await this.store.list()) this.index(sub);
  }

  async subscribe(input: CreateKeypadSubscriptionInput): Promise<KeypadSubscription> {
    const subscription: KeypadSubscription = { id: newId("keypadSubscription") as KeypadSubscriptionId, ...input };
    await this.store.put(subscription);
    this.index(subscription);
    return subscription;
  }

  async unsubscribe(id: KeypadSubscriptionId): Promise<void> {
    await this.store.remove(id);
    for (const bucket of this.byDevice.values()) bucket.delete(id);
  }

  /** Every subscription, across every watched device (for the settings UI). */
  list(): KeypadSubscription[] {
    const all: KeypadSubscription[] = [];
    for (const bucket of this.byDevice.values()) all.push(...bucket.values());
    return all;
  }

  /** Every keypad control subscribed to one device+capability's feedback. */
  subscribersFor(deviceId: DeviceId, capability: CapabilityKind): KeypadSubscription[] {
    return [...(this.byDevice.get(deviceKey(deviceId, capability))?.values() ?? [])];
  }

  private index(subscription: KeypadSubscription): void {
    const key = deviceKey(subscription.deviceId, subscription.capability);
    let bucket = this.byDevice.get(key);
    if (!bucket) {
      bucket = new Map();
      this.byDevice.set(key, bucket);
    }
    bucket.set(subscription.id, subscription);
  }
}

function deviceKey(deviceId: DeviceId, capability: CapabilityKind): string {
  return `${deviceId}:${capability}`;
}
