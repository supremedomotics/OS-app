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
