/**
 * KNX ETS import worker (§ Pass 11.3 — get the CPU-heavy import OFF the event loop).
 *
 * `setImmediate` (Pass 11.1) only moved this work AFTER the HTTP 202 was queued; it stayed
 * on the gateway's single event loop, so a real project (measured: Nirma, 4.1 MB .knxproj,
 * 1,718 signals → 491 devices, ~690 ms) starved every other API request for the whole
 * duration (measured p95 655 ms on `GET /v1/home`, vs a 2 ms warm baseline). Only a real
 * thread fixes that.
 *
 * This is deliberately plain `.mjs`, not TypeScript: it must be loadable by
 * `new Worker(url)` unchanged from a source checkout, from vitest (which serves `src/*.ts`
 * through vite, so no sibling `.js` exists), and from the production `pnpm deploy` bundle.
 * A `worker/` dir one level under the package root has the SAME relative path from both
 * `src/` and `dist/`, which no compiled-TS layout gives you. Keep the body thin: it is
 * message plumbing plus calls into the real, typed, tested engines — no KNX logic lives
 * here, and nothing here writes durable state (the pipeline is pure by design).
 */
import { parentPort, workerData } from "node:worker_threads";
import { unzipKnxproj, parseKnxSource, knxSignalsFromModel, KnxDecryptError } from "@supreme/commissioning";
import { mapUnifiedDevices, scoreConfidence, assignRoom, checkDuplicate, planBindings } from "@supreme/protocols";

/** Mirrors the gateway's own `SupremeError` codes so the main thread can rebuild the
 * exact same installer-facing error it would have thrown inline. */
function fail(code, message) {
  const err = new Error(message);
  err.supremeCode = code;
  throw err;
}

function run({ etsSource, ets, userOverrides, schemaId, knxIot, existing }) {
  let signals = ets;

  if (etsSource) {
    let source;
    if (etsSource.kind === "knxproj") {
      try {
        source = { kind: "knxproj", files: unzipKnxproj(Buffer.from(etsSource.base64, "base64"), etsSource.password) };
      } catch (err) {
        if (err instanceof KnxDecryptError) {
          fail("unauthorized", /password/i.test(err.message)
            ? "this .knxproj is password-protected — provide the ETS project password"
            : `could not decrypt .knxproj: ${err.message}`);
        }
        fail("validation_failed", `could not read .knxproj: ${err.message}`);
      }
    } else {
      source = { kind: "text", content: etsSource.content };
    }
    const etsSignals = knxSignalsFromModel(parseKnxSource(source));
    if (etsSignals.length === 0) {
      fail("validation_failed", "no group addresses were found in this project — check that you exported the correct file, or that the ETS project isn't empty.");
    }
    signals = [...(ets ?? []), ...etsSignals];
  }

  // Same window the inline path timed (§ knxInstallerQueue): synthesis onward, NOT the
  // parse above — keeps `summary.discoveryDurationMs` comparable across both paths.
  const startedAt = Date.now();
  const devices = mapUnifiedDevices({ knxIot, ets: signals, userOverrides, schemaId });
  const discoveryMs = Date.now() - startedAt;

  return {
    discoveryMs,
    items: devices.map((device) => ({
      device,
      confidence: scoreConfidence(device),
      room: assignRoom({ device }),
      duplicate: checkDuplicate(device, existing),
      plans: planBindings(device),
    })),
  };
}

try {
  parentPort.postMessage({ ok: true, ...run(workerData) });
} catch (err) {
  parentPort.postMessage({ ok: false, code: err?.supremeCode ?? null, message: err?.message ?? "the import failed for an unknown reason" });
}
