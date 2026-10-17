/**
 * Loader for the specifications' informative worked examples (IP Secure Annex A, Application Layer Annex C).
 *
 * The values are LICENSED MATERIAL and are deliberately NOT stored in this repository. They are extracted by a local script from the
 * licensed PDFs into a JSON file outside Git; tests read that file from the path in the environment variable
 * `KNX_SECURE_VECTORS`. When it is unset or unreadable, dependent tests are reported as SKIPPED — never as passed.
 */
import { existsSync, readFileSync } from "node:fs";

export type SpecVectors = Record<string, string | Record<string, string>>;

export function loadSpecVectors(): SpecVectors | null {
  const p = process.env.KNX_SECURE_VECTORS;
  if (!p || !existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8")) as SpecVectors;
}

export const vectors = loadSpecVectors();
export const hasVectors = vectors !== null;

export function v(name: string): Buffer {
  const x = vectors?.[name];
  if (typeof x !== "string") throw new Error(`spec vector ${name} missing`);
  return Buffer.from(x, "hex");
}
export function vs(name: string): string {
  const x = vectors?.[name];
  if (typeof x !== "string") throw new Error(`spec vector ${name} missing`);
  return x;
}
export function vp(name: string): Record<string, string> {
  const x = vectors?.[name];
  if (typeof x !== "object" || x === null) throw new Error(`spec vector group ${name} missing`);
  return x;
}
