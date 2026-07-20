/**
 * @supreme/domain-model — the canonical Supreme domain.
 *
 * This package is the single source of truth for Supreme domain types. It is
 * deliberately backend-agnostic: nothing here references Home Assistant. Contracts,
 * SDKs, and services all derive from these definitions so the HA → Supreme-native
 * migration never touches the domain boundary (blueprint §4, §7, §16).
 */
export * from "./ids.js";
export * from "./capabilities.js";
export * from "./entities.js";
export * from "./users.js";
export * from "./notifications.js";
export * from "./drivers.js";
export * from "./automations-dsl.js";
export * from "./device-grouping.js";
export * from "./media-topology.js";
