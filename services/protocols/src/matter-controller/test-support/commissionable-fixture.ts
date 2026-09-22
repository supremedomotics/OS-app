/**
 * (§ Matter Controller Extension, Phase 2 — test support, NOT shipped runtime code)
 *
 * A REAL `@matter/main` commissionable multi-endpoint node, used ONLY by this package's own
 * tests to exercise the Controller's commissioning/interview pipeline end-to-end against the
 * real Matter stack — never a mocked/JSON stand-in for a Matter node (§ requirement 13).
 * Endpoint shape mirrors the exact device types `matter-bridge/real-server.ts` already
 * constructs in production, so this fixture is a genuine Matter node, not a test-only shortcut.
 */
import { Environment, ServerNode, Endpoint, Logger, LogLevel } from "@matter/main";
import { OnOffLightDevice } from "@matter/main/devices/on-off-light";
import { DimmableLightDevice } from "@matter/main/devices/dimmable-light";
import { ColorTemperatureLightDevice } from "@matter/main/devices/color-temperature-light";
import { ColorControl } from "@matter/main/clusters/color-control";
import { kelvinToMireds } from "../../matter-bridge/clusters/color-control-adapter.js";

// § real @matter/main runtime constraint (found live, not guessed): ColorControlServer
// validates `colorTemperatureMireds` against `colorTempPhysicalMinMireds`/
// `colorTempPhysicalMaxMireds` at initialization — both are mandatory with NO safe default,
// so a Color Temperature Light endpoint with no explicit color-control state crashes
// endpoint construction. Same bounds `matter-bridge/real-server.ts` already uses in production.
const COLOR_TEMP_PHYSICAL_MIN_MIREDS = kelvinToMireds(10_000);
const COLOR_TEMP_PHYSICAL_MAX_MIREDS = kelvinToMireds(1_000);

/** Exported so tests can also give the `RealMatterController` under test its own distinct
 * random port, avoiding collisions with both this fixture and any leaked process. */
export function randomEphemeralPort(): number {
  return 49152 + Math.floor(Math.random() * 15000);
}

export interface CommissionableFixture {
  node: ServerNode;
  /** The real, freshly-generated PASE credentials for this node — read straight off
   * `node.state.commissioning`, same accessor `matter-bridge/real-server.ts` uses. */
  passcode: number;
  discriminator: number;
  /** The real operational UDP port this fixture actually bound to (§ Phase 3.1 — lets a
   * test commission it by known address, bypassing mDNS discovery, when the host's
   * multicast environment is unreliable). */
  port: number;
  close(): Promise<void>;
}

/**
 * Endpoint 1: On/Off Light. Endpoint 2: Dimmable Light. Endpoint 3: Color Temperature Light.
 * (§ requirement 13's minimum fixture shape.) Endpoint 0 (root) exists implicitly, with these
 * three endpoints in its real Descriptor.PartsList.
 */
export async function createCommissionableFixture(nodeId: string, storagePath: string): Promise<CommissionableFixture> {
  Logger.facilityLevels = { Commissioning: LogLevel.WARN };

  // § some Windows hosts (observed live on this one — Hyper-V/WSL NAT reserves ranges of the
  // ephemeral port space) return EACCES for a specific random port with no way to know in
  // advance; a bounded retry with a fresh random port is the standard, honest way to handle a
  // transient "this particular port is unavailable" condition — same pattern a real server
  // uses picking a port at boot, not a masked logic bug.
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt++) {
    const environment = new Environment(nodeId, Environment.default);
    environment.vars.set("storage.path", storagePath);
    const port = randomEphemeralPort();
    try {
      const node = await ServerNode.create({
        id: nodeId,
        environment,
        network: { port },
        basicInformation: {
          vendorName: "Fixture Vendor",
          productName: "Fixture Multi-Endpoint Device",
          nodeLabel: "Fixture Device",
        },
      });

      // § start BEFORE adding endpoints, then add them one at a time — matches
      // `matter-bridge/real-server.ts`'s own proven-stable pattern (its own multi-endpoint
      // test, `real-server.device-types.test.ts`, adds several light endpoints sequentially
      // to an already-started node without issue). Adding several endpoints to a node BEFORE
      // its first `start()` hit a real Windows-only `@matter/nodejs` `FileStorageDriver`
      // rename race on the endpoint-number persistence file — a vendor-library environment
      // quirk, not a SupremeOS logic bug — that this ordering avoids entirely.
      await node.start();
      await node.add(new Endpoint(OnOffLightDevice, { id: "onoff-light", number: 1 }));
      await node.add(new Endpoint(DimmableLightDevice, { id: "dimmable-light", number: 2 }));
      await node.add(
        new Endpoint(ColorTemperatureLightDevice, {
          id: "ct-light",
          number: 3,
          colorControl: {
            colorTempPhysicalMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            colorTempPhysicalMaxMireds: COLOR_TEMP_PHYSICAL_MAX_MIREDS,
            coupleColorTempToLevelMinMireds: COLOR_TEMP_PHYSICAL_MIN_MIREDS,
            colorTemperatureMireds: kelvinToMireds(3000),
            startUpColorTemperatureMireds: null,
            // § real @matter/main runtime constraint (found live): ColorMode is conformance
            // "M" (mandatory) with no default — matches `matter-bridge/real-server.ts`'s own
            // Color Temperature Light construction.
            colorMode: ColorControl.ColorMode.ColorTemperatureMireds,
          },
        }),
      );

      const commissioning = node.state.commissioning;
      return {
        node,
        passcode: commissioning.passcode,
        discriminator: commissioning.discriminator,
        port,
        close: () => node.close(),
      };
    } catch (err) {
      lastError = err;
      if (!isBindError(err)) throw err;
    }
  }
  throw lastError;
}

function isBindError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /EACCES|EADDRINUSE|address.*in use|Cannot bind/i.test(message);
}
