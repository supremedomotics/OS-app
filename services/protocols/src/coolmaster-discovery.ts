import type { CoolMasterConnection } from "./coolmaster-connection.js";
import { cmdLine, cmdProps, cmdQuery } from "./coolmaster-commands.js";
import { CoolMasterDiscoveryError } from "./coolmaster-errors.js";
import type { CoolMasterScopedLogger } from "./coolmaster-logger.js";
import {
  mergeQueryDetail,
  parseGroupLine,
  parseLineInfo,
  parseMainControllerLine,
  parsePropsBlock,
  parseVentilationLine,
  parseWaterHeaterLine,
} from "./coolmaster-parser.js";
import type { CoolMasterDiscoveryResult, CoolMasterUnitStatus } from "./coolmaster-types.js";

/**
 * Full discovery pass (§ "Auto Discovery (Mandatory)... The user should never manually
 * create indoor units"): gateway identity, HVAC lines, indoor units, groups, water
 * heaters, ventilation. Re-run on connect, on gateway reconnect, on a configurable
 * interval, and on-demand — coolmaster-driver.ts owns scheduling; this module is pure
 * "go fetch everything, right now" logic.
 *
 * Water heater / ventilation / main controller / group discovery each fail
 * INDEPENDENTLY and gracefully: a gateway with no water heaters isn't a driver error,
 * it's a normal installation, so one type's "unsupported command" response never blocks
 * indoor-unit discovery (the one type every installation has) or the other types.
 */

const commandNames = { info: "info", line: cmdLine(), wh: "wh", vam: "vam", main: "main", group: "group" };

export async function discoverAll(
  connection: CoolMasterConnection,
  logger: CoolMasterScopedLogger | undefined,
  opts: { enrichWithQuery?: boolean; includeNames?: boolean } = {},
): Promise<CoolMasterDiscoveryResult> {
  const gateway = connection.gatewayInfo();
  if (!gateway) {
    throw new CoolMasterDiscoveryError("coolmaster: cannot discover before the gateway connection is established");
  }

  const lines = await discoverLines(connection, logger);
  let units = await connection.getUnitStatuses();
  if (opts.enrichWithQuery !== false) {
    units = await enrichUnitsWithQuery(connection, logger, units);
  }
  const [groups, waterHeaters, ventilation, mainControllers, propNames] = await Promise.all([
    discoverGroups(connection, logger),
    discoverWaterHeaters(connection, logger),
    discoverVentilation(connection, logger),
    discoverMainControllers(connection, logger),
    opts.includeNames !== false ? discoverPropNames(connection, logger) : Promise.resolve(new Map<string, string>()),
  ]);

  const result: CoolMasterDiscoveryResult = { gateway, lines, units, groups, waterHeaters, ventilation, mainControllers, propNames };
  logger?.info("discovery complete", {
    units: units.length,
    lines: lines.length,
    groups: groups.length,
    waterHeaters: waterHeaters.length,
    ventilation: ventilation.length,
    mainControllers: mainControllers.length,
    friendlyNames: propNames.size,
  });
  return result;
}

async function discoverLines(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined) {
  try {
    const lines = await connection.executeAscii(commandNames.line);
    return parseLineInfo(lines);
  } catch (err) {
    logger?.warn("HVAC line discovery failed — continuing with units only", { error: (err as Error).message });
    return [];
  }
}

/** `query <uid>` fills in the fields ls2 doesn't reliably carry (swing/filter/demand/
 * fault/lock/inhibit — see coolmaster-parser.ts's confidence notes). Run ONCE per
 * discovery pass, never on every poll cycle — querying each unit individually on a fast
 * poll would violate "avoid unnecessary API traffic" at the "hundreds of indoor units"
 * scale this driver must support (§ Performance). Regular polling (coolmaster-polling.ts)
 * uses the bulk ls2 read alone. */
async function enrichUnitsWithQuery(
  connection: CoolMasterConnection,
  logger: CoolMasterScopedLogger | undefined,
  units: CoolMasterUnitStatus[],
): Promise<CoolMasterUnitStatus[]> {
  const enriched: CoolMasterUnitStatus[] = [];
  for (const unit of units) {
    try {
      const lines = await connection.executeAscii(cmdQuery(unit.uid));
      enriched.push(mergeQueryDetail(unit, lines));
    } catch (err) {
      logger?.debug("query enrichment failed for unit, keeping ls2 data", { uid: unit.uid, error: (err as Error).message });
      enriched.push(unit);
    }
  }
  return enriched;
}

async function discoverGroups(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined) {
  try {
    const lines = await connection.executeAscii(commandNames.group);
    return lines.map(parseGroupLine).filter((g): g is NonNullable<typeof g> => g !== null);
  } catch (err) {
    logger?.debug("group discovery unavailable on this gateway", { error: (err as Error).message });
    return [];
  }
}

async function discoverWaterHeaters(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined) {
  try {
    const lines = await connection.executeAscii(commandNames.wh);
    return lines.map(parseWaterHeaterLine).filter((w): w is NonNullable<typeof w> => w !== null);
  } catch (err) {
    logger?.debug("water heater discovery unavailable on this gateway", { error: (err as Error).message });
    return [];
  }
}

async function discoverVentilation(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined) {
  try {
    const lines = await connection.executeAscii(commandNames.vam);
    return lines.map(parseVentilationLine).filter((v): v is NonNullable<typeof v> => v !== null);
  } catch (err) {
    logger?.debug("ventilation discovery unavailable on this gateway", { error: (err as Error).message });
    return [];
  }
}

async function discoverMainControllers(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined) {
  try {
    const lines = await connection.executeAscii(commandNames.main);
    return lines.map(parseMainControllerLine).filter((m): m is NonNullable<typeof m> => m !== null);
  } catch (err) {
    logger?.debug("main controller discovery unavailable on this gateway", { error: (err as Error).message });
    return [];
  }
}

/** § Friendly Name Discovery. Run ONCE per FULL discovery pass — initial discovery, the
 * periodic full re-discovery interval, explicit rediscovery, and gateway reconnect (all
 * of which route through `discoverAll` with the default `includeNames: true`) — never on
 * every fast poll cycle, and explicitly skipped by `refreshSecondaryDevices`' targeted
 * post-command refresh (`includeNames: false`), which isn't one of the allowed cadences.
 * Fails independently like every other secondary discovery call: a gateway with no `props`
 * support simply yields an empty map, never a driver error. */
async function discoverPropNames(connection: CoolMasterConnection, logger: CoolMasterScopedLogger | undefined): Promise<Map<string, string>> {
  try {
    const lines = await connection.executeAscii(cmdProps());
    return parsePropsBlock(lines);
  } catch (err) {
    logger?.debug("friendly-name (props) discovery unavailable on this gateway", { error: (err as Error).message });
    return new Map();
  }
}
