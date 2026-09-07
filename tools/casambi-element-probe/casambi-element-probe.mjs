#!/usr/bin/env node
/**
 * Casambi custom-element probe (§ Casambi Local Gateway — curtain motor open/close, TODO.md).
 *
 * Send-only UDP prober for opcode 0x3F SetTargetElements. Exists because a device's 8 custom
 * elements (index 0-7, § System Manual 6.38 §5.12.2.2.18) have no discoverable index unless the
 * device happens to report them in LONG form (0x8F/0x90 : INDEX : LEN) — a real curtain motor was
 * observed reporting its position slider in SHORT form (`0f.<lo>.<hi>`), which carries no index at
 * all. Two inferences about that index have already been wrong on real hardware, so this probes
 * for it empirically instead: writing an unsupported element is a documented no-op (live-confirmed
 * — the motor ignored out-of-range values entirely), which makes a sweep safe.
 *
 * Deliberately SEND-ONLY. The gateway sends and receives on one shared port (§ gateway config
 * p.80), which the running SupremeOS driver already binds; a probe that also tried to receive
 * would either fail to bind or steal the driver's notifications. Read the result off the physical
 * fixture or the Casambi app instead.
 *
 * Usage:
 *   node casambi-element-probe.js --host 192.168.0.45 --unit 45 --sweep
 *   node casambi-element-probe.js --host 192.168.0.45 --unit 45 --hold 1 3000
 *   node casambi-element-probe.js --host 192.168.0.45 --unit 45 --set 2 128
 *
 *   --port <n>    gateway UDP port          (default 5000)
 *   --netid <n>   this bridge's Net ID      (default 12 / 0x0c)
 *   --dec         "dec with hash" wire format instead of the default "hex with dot"
 *   --gap <ms>    pause between sweep steps (default 5000)
 */
import dgram from "node:dgram";

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const host = flag("host", process.env.CASAMBI_GATEWAY_IP);
const port = Number(flag("port", 5000));
const netId = Number(flag("netid", 12));
const unit = Number(flag("unit", NaN));
const gapMs = Number(flag("gap", 5000));
const dec = has("dec");

if (!host || !Number.isFinite(unit)) {
  console.error("usage: --host <gateway-ip> --unit <casambi-unit-id> [--sweep | --hold <idx> <ms> | --set <idx> <value>]");
  process.exit(2);
}

const TARGET_TYPE_DEVICE = 1;

/** One 0x3F frame, byte-identical to `udp-codec.ts`'s `encodeSetTargetElements` + `encodeCasambiPacket`. */
function setElement(index, value) {
  const args = [TARGET_TYPE_DEVICE, unit, 0, 0, index, value]; // TargetType, TargetID, Dur_lo, Dur_hi, Index, Value
  const fields = [netId, 0x72, 1 + args.length, 0x3f, ...args];
  return dec
    ? `${fields.map((n) => String(n).padStart(3, "0")).join("#")}\r\n`
    : `${fields.map((n) => n.toString(16)).join(".")}\r\n`;
}

const sock = dgram.createSocket("udp4");
const send = (wire) =>
  new Promise((resolve, reject) => {
    process.stdout.write(`-> ${wire.trimEnd()}\n`);
    sock.send(Buffer.from(wire, "ascii"), port, host, (err) => (err ? reject(err) : resolve()));
  });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (has("sweep")) {
    console.log(`Sweeping elements 0-7 on unit ${unit} with value 128, ${gapMs}ms apart.`);
    console.log("Watch the fixture (or the Casambi app). The index that drives it to ~50% is the slider.\n");
    for (let index = 0; index <= 7; index++) {
      console.log(`--- element ${index} ---`);
      await send(setElement(index, 128));
      await wait(gapMs);
    }
  } else if (has("hold")) {
    const i = argv.indexOf("--hold");
    const index = Number(argv[i + 1]);
    const ms = Number(argv[i + 2]);
    console.log(`Pressing element ${index} on unit ${unit}, holding ${ms}ms, then releasing.`);
    await send(setElement(index, 1));
    await wait(ms);
    await send(setElement(index, 0));
  } else if (has("set")) {
    const i = argv.indexOf("--set");
    await send(setElement(Number(argv[i + 1]), Number(argv[i + 2])));
  } else {
    console.error("pick one of --sweep, --hold <idx> <ms>, --set <idx> <value>");
    process.exit(2);
  }
  sock.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
