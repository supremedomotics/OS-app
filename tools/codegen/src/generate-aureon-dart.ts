/**
 * Generate the Aureon Flutter token file from the canonical token JSON, so
 * `aureon-flutter` and `aureon-web` always share one source of visual truth
 * (blueprint §11.2). Run with: `pnpm --filter @supreme/codegen gen:aureon-dart`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aureon } from "@supreme/aureon-web";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../../../packages/aureon-flutter/lib/src/tokens.g.dart");

function hexToDartColor(hex: string): string {
  const h = hex.replace("#", "");
  const argb = h.length === 6 ? `FF${h}` : h;
  return `Color(0x${argb.toUpperCase()})`;
}

function colorBlock(name: string, group: Record<string, string>): string {
  const fields = Object.entries(group)
    .map(([k, v]) => `  static const Color ${dartName(k)} = ${hexToDartColor(v)};`)
    .join("\n");
  return `class Aureon${cap(name)} {\n  const Aureon${cap(name)}._();\n${fields}\n}`;
}

// Dart reserved words that cannot be used as identifiers.
const DART_RESERVED = new Set(["void", "class", "const", "default", "in", "is", "new", "null", "switch", "this", "true", "false", "var", "final"]);

function dartName(key: string): string {
  const n = key.replace(/[^a-zA-Z0-9]/g, "");
  const camel = /^\d/.test(n) ? `c${n}` : n.charAt(0).toLowerCase() + n.slice(1);
  return DART_RESERVED.has(camel) ? `${camel}Color` : camel;
}
function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const c = aureon.color;
const sp = aureon.spacing;
const r = aureon.radius;
const m = aureon.motion;

const dart = `// GENERATED FILE — DO NOT EDIT.
// Source of truth: packages/aureon-web/tokens/aureon.tokens.json
// Regenerate: pnpm --filter @supreme/codegen gen:aureon-dart
//
// Aureon design tokens (blueprint §11.2): dark, architectural, gold-accented.
import 'package:flutter/widgets.dart';

${colorBlock("base", c.base)}

${colorBlock("gold", c.gold)}

${colorBlock("text", c.text)}

${colorBlock("status", c.status)}

class AureonSpacing {
  const AureonSpacing._();
  static const double unit = ${sp.unit.toFixed(1)};
  static const double xs = ${sp.xs.toFixed(1)};
  static const double sm = ${sp.sm.toFixed(1)};
  static const double md = ${sp.md.toFixed(1)};
  static const double lg = ${sp.lg.toFixed(1)};
  static const double xl = ${sp.xl.toFixed(1)};
  static const double xxl = ${sp.xxl.toFixed(1)};
}

class AureonRadius {
  const AureonRadius._();
  static const double sm = ${r.sm.toFixed(1)};
  static const double md = ${r.md.toFixed(1)};
  static const double lg = ${r.lg.toFixed(1)};
  static const double pill = ${r.pill.toFixed(1)};
}

class AureonMotion {
  const AureonMotion._();
  static const Duration fast = Duration(milliseconds: ${m.durationFastMs});
  static const Duration base = Duration(milliseconds: ${m.durationBaseMs});
  static const Duration slow = Duration(milliseconds: ${m.durationSlowMs});
  static const Cubic quietOut = Cubic(${m.easeQuietOut.join(", ")});
  static const Cubic slowIn = Cubic(${m.easeSlowIn.join(", ")});
}
`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, dart);
console.log(`Generated ${OUT}`);
