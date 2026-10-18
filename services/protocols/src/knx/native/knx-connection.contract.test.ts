import { legacyHarness, nativeHarness } from "./simulator/contract-harnesses.js";
import { defineKnxConnectionContract } from "./simulator/knx-connection.contract.js";

// The same behavioural table, executed against the production wrapper (real knxultimate dptlib, modelled client) and against NativeKnxConnection (simulator).
defineKnxConnectionContract("legacy", legacyHarness);
defineKnxConnectionContract("native", nativeHarness);
