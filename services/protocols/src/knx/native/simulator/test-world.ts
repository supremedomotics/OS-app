/**
 * TEST SUPPORT ONLY (simulator). A deterministic KNX world — manual clock, virtual network, line and gateway — plus a factory for
 * {@link NativeKnxConnection}s that tunnel into it. Used by the connection, contract and parity suites. Results obtained here are simulated
 * results; they say nothing about real gateways or devices.
 */
import { parseGroupAddress, parseIndividualAddress } from "../address.js";
import { NativeKnxConnection, type NativeKnxConnectionOptions } from "../knx-connection.js";
import { ManualClock, VirtualActuator, VirtualKnxBus, VirtualKnxInterface, VirtualNetwork, VirtualSender, type VirtualInterfaceOptions } from "./index.js";
import { KnxTunnelClient, type TunnelClientOptions } from "../tunnel-client.js";
import type { Clock } from "../transport.js";

export const GW = "10.0.0.2";
export const GA = (s: string): number => parseGroupAddress(s);
export const IA = (s: string): number => parseIndividualAddress(s);

const TUNNEL: Partial<TunnelClientOptions> = { heartbeatIntervalMs: 20_000, heartbeatTimeoutMs: 2_000, heartbeatMaxFailures: 2, connectTimeoutMs: 5_000 };

export interface WorldOptions {
  tunnel?: Partial<TunnelClientOptions>;
  interface?: Partial<VirtualInterfaceOptions>;
  /** Use this clock instead of a ManualClock (the parity harness uses the real one so promises settle without a driver loop). */
  clock?: Clock;
}

export function createWorld(opts: WorldOptions = {}) {
  const clock = (opts.clock ?? new ManualClock()) as ManualClock;
  const net = new VirtualNetwork(clock, 1);
  const bus = new VirtualKnxBus(clock);
  const iface = new VirtualKnxInterface(net, bus, clock, { address: GW, ...opts.interface });
  const sender = new VirtualSender(IA("1.1.50"));
  bus.addDevice(sender);
  const tunnels: KnxTunnelClient[] = [];
  const createTunnel = (): KnxTunnelClient => {
    const t = new KnxTunnelClient({ host: GW, socketFactory: net.createSocketFactory("10.0.0.50"), clock, ...TUNNEL, ...opts.tunnel });
    tunnels.push(t);
    return t;
  };
  const connections: NativeKnxConnection[] = [];
  const connection = (o: Partial<NativeKnxConnectionOptions> = {}): NativeKnxConnection => {
    const c = new NativeKnxConnection({ createTunnel, clock, reconnect: { minBackoffMs: 2_000, maxBackoffMs: 20_000, random: () => 0.5 }, ...o });
    connections.push(c);
    return c;
  };
  const actuator = (ia: string, commandGa: string, feedbackGa: string | null, dpt = "1.001", initial: boolean | number = false): VirtualActuator => {
    const a = new VirtualActuator({ individualAddress: IA(ia), commandGa: GA(commandGa), feedbackGa: feedbackGa === null ? null : GA(feedbackGa), dpt, initial }, clock);
    bus.addDevice(a);
    return a;
  };
  /** Advances virtual time 1 ms at a time until `p` settles; throws if it does not within `maxMs`. */
  async function until<T>(p: Promise<T>, maxMs = 200): Promise<T> {
    let settled = false;
    p.then(() => { settled = true; }, () => { settled = true; });
    for (let i = 0; i < maxMs && !settled; i++) await clock.advance(1);
    if (!settled) throw new Error(`promise still pending after ${maxMs} ms of virtual time`);
    return p;
  }
  const leaks = () => ({ timers: clock.pendingTimers, sockets: net.openClientSockets, channels: iface.activeChannels });
  return { clock, net, bus, iface, sender, tunnels, createTunnel, connection, connections, actuator, until, leaks };
}

export type World = ReturnType<typeof createWorld>;
