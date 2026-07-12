/**
 * Re-exports the shared Aureon icon registry (§ Design System — Iconography). This used to be an
 * independent copy of the same line icons; now `@supreme/aureon-web` is the one source of truth,
 * and `device-tile.tsx`'s separately-drawn `DeviceIcon` is the only icon set left to consolidate.
 */
export { Icon } from "@supreme/aureon-web";
