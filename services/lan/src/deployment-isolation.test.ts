import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * § Production Architecture Direction — structural guard.
 *
 * "Keep Docker-specific code isolated. Avoid embedding Docker assumptions into protocol logic.
 * Separate transport implementation from deployment implementation."
 *
 * That is easy to agree with and easy to erode one convenient string at a time — which is exactly
 * how `"bridge" | "host" | "macvlan"` ended up in the wire protocol, the health snapshot, and the
 * failure diagnosis in the first place. This test makes the rule enforceable rather than
 * aspirational: `server/deployment.ts` is the ONE module allowed to name a container runtime, and
 * everything else in `@supreme/lan` must stay deployment-agnostic so the same code ships unchanged
 * to a native SupremeOS systemd service.
 *
 * Two deliberate exemptions, both about what actually ships:
 *
 *  - **Doc comments.** Explaining WHY a limitation exists, with its real reproduced evidence, is
 *    valuable and carries no runtime coupling. Only executable code is checked.
 *  - **`*.test.ts`.** A test MUST be able to construct `DEPLOYMENTS["docker-bridge"]` and assert
 *    its remediation text — that is *consuming* the isolated module, the opposite of a leak, and
 *    it is how the deployment-specific behavior gets verified at all. Tests ship nothing.
 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

/** The ONE shipped module allowed to know deployment/runtime specifics. */
const ALLOWED = new Set(["server/deployment.ts"]);

const FORBIDDEN = [/\bdocker\b/i, /\bcompose\b/i, /\bmacvlan\b/i, /network_mode/i, /\bsystemd\b/i];

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".ts") && !e.name.includes(".test.") && !e.name.includes(".smoke."))
    .map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/** Strips block and line comments so only executable code is inspected. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("deployment isolation (§ Production Architecture Direction)", () => {
  it("no shipped @supreme/lan module except deployment.ts names a container runtime in executable code", async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(5); // sanity: the scan actually found the package
    // …and that it is really reading the module it exempts, so ALLOWED can't silently mismatch.
    expect(files.map((f) => path.relative(SRC, f).split(path.sep).join("/"))).toContain("server/deployment.ts");

    const offenders: string[] = [];
    for (const file of files) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (ALLOWED.has(rel)) continue;
      const code = stripComments(await readFile(file, "utf8"));
      for (const pattern of FORBIDDEN) {
        const m = code.match(pattern);
        if (m) offenders.push(`${rel}: ${m[0]}`);
      }
    }

    expect(
      offenders,
      `Deployment-specific vocabulary leaked into the transport layer. Move it into server/deployment.ts — that module exists precisely so removing Docker is a deployment change, not a transport rewrite.\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("the transport's own wire protocol carries no container-runtime union type", async () => {
    const wire = await readFile(path.join(SRC, "shared/wire-types.ts"), "utf8");
    // The specific regression this guards: `networkMode: "bridge" | "host" | "macvlan"`.
    expect(stripComments(wire)).not.toMatch(/"bridge"\s*\|\s*"host"/);
  });
});
