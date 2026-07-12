import tokens from "../tokens/aureon.tokens.json" with { type: "json" };

/**
 * @supreme/aureon-web — the web mirror of the Aureon design tokens (§11.2).
 *
 * The canonical values live in `tokens/aureon.tokens.json`. This module re-exports
 * them as a typed object and can emit them as CSS custom properties for the web
 * homeowner + installer apps. The Flutter mirror (`aureon-flutter`) is generated
 * from the very same JSON so both clients render one source of visual truth.
 */
export type AureonTokens = typeof tokens;
export const aureon: AureonTokens = tokens;

export {
  AUREON_MODES,
  AUREON_ACCENTS,
  resolveMode,
  applyAureonTheme,
  loadAureonTheme,
  saveAureonTheme,
  initAureonTheme,
  type AureonMode,
  type AureonAccent,
  type AureonThemeChoice,
} from "./theme.js";

// ── Component library (§ Design System Phase 0) ──────────────────────────────
// Import "@supreme/aureon-web/components.css" once at the app root alongside these.
export { Button, IconButton, type ButtonProps, type ButtonVariant, type ButtonSize, type IconButtonProps } from "./components/Button.js";
export { Card, type CardProps, type CardVariant } from "./components/Card.js";
export { Chip, Badge, StatusDot, SegmentedControl, type ChipProps, type BadgeProps, type StatusDotProps, type StatusTone, type SegmentedControlProps, type SegmentedControlOption } from "./components/Chip.js";
export { Sheet, type SheetProps, type SheetPresentation } from "./components/Sheet.js";
export { OverflowMenu, type OverflowMenuProps, type OverflowMenuAction } from "./components/OverflowMenu.js";
export { Icon, iconForCapabilities, type IconName, type IconProps } from "./components/Icon.js";
export { DeviceFacts, type DeviceFactsProps, type DeviceFactRow } from "./components/DeviceFacts.js";
export { CollapsibleSection, type CollapsibleSectionProps } from "./components/CollapsibleSection.js";
export { Grid, type GridProps } from "./components/Grid.js";
export { Container, type ContainerProps } from "./components/Container.js";
export { Stack, type StackProps, type StackGap } from "./components/Stack.js";
export { CapabilityGate, type CapabilityGateProps } from "./components/CapabilityGate.js";
export { QuickActions, type QuickActionsProps, type QuickAction } from "./components/QuickActions.js";
export { Timeline, type TimelineProps, type TimelineEntry } from "./components/Timeline.js";
export { AUREON_BREAKPOINT, densityForWidth, useAureonDensity, applyAureonDensity, initAureonDensity, type AureonDensity } from "./responsive.js";

/** Flatten the token tree into CSS-variable name/value pairs. */
function flatten(obj: Record<string, unknown>, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith("$") || key === "meta") continue;
    const name = `${prefix}-${kebab(key)}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out.push(...flatten(value as Record<string, unknown>, name));
    } else if (Array.isArray(value)) {
      out.push([name, value.join(", ")]);
    } else {
      out.push([name, String(value)]);
    }
  }
  return out;
}

function kebab(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Emit the Aureon tokens as a `:root { --aureon-…: … }` CSS block. */
export function toCssVariables(): string {
  const vars = flatten(aureon as unknown as Record<string, unknown>, "--aureon")
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${vars}\n}\n`;
}
