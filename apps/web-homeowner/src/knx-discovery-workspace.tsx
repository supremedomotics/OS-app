import { useEffect, useMemo, useRef, useState } from "react";
import {
  approveKnxDevice,
  client,
  HttpError,
  knxDiscoveryQueue,
  knxDiscoveryQueueJobCancel,
  knxDiscoveryQueueJobStart,
  knxDiscoveryQueueJobStatus,
  KNX_UPLOAD_CHUNK_BYTES,
  type KnxApprovalResult,
  type KnxImportJobStatus,
  type KnxInstallerQueueItem,
  type KnxQueueSection,
} from "./api.js";

// § Pass 11.2 — persists the in-flight job's id so a page refresh/navigation can
// re-poll it instead of losing track of (or, worse, re-starting) a running import.
// Same localStorage-for-client-side-continuity idiom this app already uses elsewhere
// (homes.ts active-home id, screens.tsx scene order, settings.tsx a11y prefs).
const KNX_JOB_KEY = "supreme.knxImportJobId";
const JOB_POLL_MS = 1200;
// § Room-selector fix — a sentinel roomId value meaning "installer typed a brand-new room
// name," distinct from "" (Automatic — accept whatever room-assignment already inferred,
// see room-assignment.ts). Neither the existing room list nor the auto-detected hint always
// has the right answer (e.g. a KNX actuator's ETS-recorded mounting location, now correctly
// excluded from being trusted as a room name for technical/utility spaces — see room-
// assignment.ts's TECHNICAL_ROOM_NAMES — still leaves nothing for circuit_intelligence to
// find on a device whose own name doesn't carry a room prefix), so installers need an
// explicit way to just type the room they want.
const NEW_ROOM_SENTINEL = "__new_room__";

/**
 * KNX Discovery Summary + Device Review Workspace (§ Discovery Workflow, § Final
 * Production Workflow & Installer Completion).
 *
 * Exposes the EXISTING Unified Device Intelligence pipeline
 * (discoverUnified -> Confidence Engine -> Room Assignment -> Duplicate Detection ->
 * Binding Engine, all in `knxDiscoveryQueue()`) — no discovery/grouping/confidence
 * logic lives in this file, only the presentation of what the backend already computed,
 * plus purely client-side review affordances (search/filter/sort/bulk select/reject)
 * over that same data. Reject never calls the backend — nothing is actually created
 * until Approve runs, so "rejecting" a queue item is just removing it from view.
 */

type Filter = KnxQueueSection | "unsupported" | "already_installed" | "rejected";
const FILTER_LABEL: Record<Filter, string> = {
  ready: "Ready",
  needs_review: "Needs Review",
  duplicates: "Duplicates",
  conflicts: "Conflicts",
  unsupported: "Unsupported",
  already_installed: "Already Installed",
  rejected: "Rejected",
};
const FILTER_ORDER: Filter[] = ["ready", "needs_review", "duplicates", "conflicts", "unsupported", "already_installed", "rejected"];

type SortKey = "confidence" | "room" | "device_type" | "discovery_order" | "alphabetical";
const SORT_LABEL: Record<SortKey, string> = {
  discovery_order: "Discovery order",
  alphabetical: "Alphabetical",
  confidence: "Confidence",
  room: "Room",
  device_type: "Device type",
};

// § Pass 27 P0-A — a resumed job id from localStorage must never disable the Scan
// button before its status is actually confirmed. Import jobs live ONLY in the
// gateway's in-memory map (nothing evicts them, but a gateway restart wipes them, and
// `finishScan` deliberately leaves a COMPLETED job's id in place — see Pass 16 fix
// below), so a leftover id from any earlier session/tab/reused Incognito window is
// common, not exceptional. Pure so the branch is unit-testable without mounting.
export function resumeAction(status: KnxImportJobStatus | "gone"): "scanning" | "done" | "reset" {
  if (status === "queued" || status === "running") return "scanning";
  if (status === "completed") return "done";
  return "reset"; // failed, cancelled, or gone (404/unreachable) — never block a fresh scan on this
}

// § Pass 11.2 — real, coarse stages only (see KnxImportJobStage in installer-context.ts);
// no fabricated fine-grained progress bar over a pipeline that isn't actually instrumented
// stage-by-stage internally.
/** Pure gate for the Scan/Discover button and the file input — extracted so the
 * condition is unit-testable without mounting the component (no React Testing Library
 * in this app's test setup — see other *.test.ts files in this directory).
 *
 * § Formerly also gated on a `readingFile` flag covering the async-read + CPU-bound
 * base64-encode window `onFile()` used to run in for a `.knxproj` upload. That entire
 * window is now structurally gone: the file travels to the backend as a real
 * `multipart/form-data` upload (see `knxDiscoveryQueueJobStart` in api.ts), so
 * `onFile()` just stores the `File` object — no async read, no encode loop, nothing
 * to race the button click against. */
export function canStartKnxScan(phase: "idle" | "scanning" | "done" | "error"): boolean {
  return phase !== "scanning";
}

/** § UX fix — an ETS project file and a pasted group-address export were previously shown as
 * two always-visible inputs at once, even though they're mutually exclusive alternatives (the
 * code already enforced this: selecting a file cleared the pasted text and vice versa) — just
 * not communicated visually, which read as "you can use both." Installers must now pick ONE
 * source explicitly; only that source's input renders. A bare live gateway/KNX-IoT scan (no
 * ETS source at all) remains available regardless — the mode picker only governs which ETS
 * INPUT is shown, not whether scanning requires one. Pure function so the choice logic is
 * unit-testable without mounting the component. */
export type EtsSourceMode = "project" | "pasted" | null;

function jobStatusLabel(status: KnxImportJobStatus | null): string {
  switch (status) {
    case "queued": return "Queued…";
    case "running": return "Parsing & synthesizing devices…";
    default: return "Starting…";
  }
}

// § P0-C (Pass 28) — the generic "color" capability name doesn't distinguish a Kelvin-
// only tunable-white fixture from an RGB(W) one, which is exactly what a real ETS
// project's DPT tells you (DPT7/9 = Kelvin, DPT232/233/251 = RGB(W)) — the binding
// engine already computes this (`colorModesFromDpt`, § services/protocols/src/knx/
// binding-engine.ts) and sends it down on the "color" plan's `config.colorModes`. This
// reads ONLY that server-computed evidence — never re-derives from a device/GA name —
// so the review card can show "CCT"/"RGB" instead of the ambiguous "color" the moment
// the DPT evidence exists, without waiting for approval + live state feedback. Falls
// back to the plain capability name when no plan resolved colorModes (DPT genuinely
// unknown/absent) — an honest "we don't know which yet," never a guess.
export function capabilityDisplayLabels(capabilities: string[], plans: { capability: string; config: Record<string, unknown> }[]): string[] {
  return capabilities.map((cap) => {
    if (cap !== "color") return cap;
    const modes = plans.find((p) => p.capability === "color")?.config.colorModes as { rgb: boolean; cct: boolean } | undefined;
    if (!modes) return "color";
    if (modes.rgb && modes.cct) return "rgb+cct";
    if (modes.cct) return "cct";
    if (modes.rgb) return "rgb";
    return "color";
  });
}

function itemFilters(item: KnxInstallerQueueItem, rejected: boolean): Filter[] {
  const f: Filter[] = [item.section];
  if (item.device.capabilities.length === 0 || item.device.raw.deviceKind === "unknown") f.push("unsupported");
  if (item.duplicate.decision === "update" || item.duplicate.decision === "merge") f.push("already_installed");
  if (rejected) f.push("rejected");
  return f;
}

export function KnxDiscoveryWorkspace() {
  const [phase, setPhase] = useState<"idle" | "scanning" | "done" | "error">("idle");
  const [result, setResult] = useState<Awaited<ReturnType<typeof knxDiscoveryQueue>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // § Pass 11.2 async job tracking — jobId/jobStatus drive the "Scanning…" progress
  // display; the actual pipeline runs in the gateway, not on this request, so the
  // browser stays fully usable while it's in flight.
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<KnxImportJobStatus | null>(null);
  // Non-null only while the chunked upload itself is still in flight (no jobId yet) —
  // distinct from "queued"/"running", which only exist once the gateway has actually
  // received the whole file and created the job. Real chunk counts, not a guess — see
  // scan()'s own comment and api.ts's uploadKnxprojChunked.
  const [uploadProgress, setUploadProgress] = useState<{ sent: number; total: number } | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  const [approved, setApproved] = useState<Record<string, KnxApprovalResult>>({});
  const [approving, setApproving] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, { name: string; roomId: string; newRoomName?: string }>>({});

  // Review workspace: search / filter / sort / bulk selection / reject (§ Device Review
  // Workspace — all purely client-side over the one queue the backend already returned).
  const [query, setQuery] = useState("");
  const [activeFilters, setActiveFilters] = useState<Set<Filter>>(new Set(["ready", "needs_review", "duplicates", "conflicts"]));
  const [sortKey, setSortKey] = useState<SortKey>("discovery_order");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejected, setRejected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  // ETS Project Import (§ Unify ETS Import & Discovery Pipeline) — an ETS export is just
  // another SIGNAL SOURCE into the same discoverUnified() pipeline live scanning uses, so
  // it's staged here rather than as a separate import panel/workflow. No parsing or
  // commissioning logic lives in this file — `content`/`knxproj` are handed to the
  // backend as-is, which parses (never commissions) and merges them into the same queue.
  const [etsText, setEtsText] = useState("");
  // The selected `.knxproj` File object itself — travels to the backend as a real
  // multipart file upload (§ fixes a real production bug: a browser extension in the
  // user's normal Chrome profile interfered with the previous ~13-18MB base64 JSON
  // body; native file upload sidesteps that, and also removes the need to ever read/
  // encode the file client-side at all).
  const [etsFile, setEtsFile] = useState<File | null>(null);
  const [etsFileName, setEtsFileName] = useState<string | null>(null);
  const [etsPassword, setEtsPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  // § UX fix — which ETS source input is shown; null = not chosen yet, so neither the file
  // picker nor the paste box renders until the installer explicitly picks one.
  const [sourceMode, setSourceMode] = useState<EtsSourceMode>(null);

  useEffect(() => {
    void client.home().then((h) => setRooms(h.rooms.map((r) => ({ id: r.id, name: r.name }))));
  }, []);

  // § Pass 11.2 refresh/navigation recovery, hardened in Pass 27 (P0-A) — a job started
  // before this component mounted (previous page load) keeps running on the gateway
  // regardless (a background worker thread tied to the job map, not the original
  // request's lifecycle), so re-adopting a saved jobId and resuming polling is correct
  // when that job is real. But blindly trusting ANY id found in localStorage and
  // immediately flipping `phase` to "scanning" — before ever confirming the job still
  // exists — disables the Scan button (canStartKnxScan gates on phase !== "scanning")
  // for however long the first poll takes. Jobs are in-memory only on the gateway
  // (nothing evicts a completed one, but a gateway restart wipes them, and a
  // completed job's id is deliberately left in place — see finishScan's Pass 16 fix
  // below), so a stale id from an earlier session/tab/reused Incognito window is
  // common. The fix: resolve the real status once, eagerly, BEFORE touching `phase`
  // at all — a dead/stale job never disables the button, so the very first click
  // after page load is never silently swallowed.
  useEffect(() => {
    const saved = localStorage.getItem(KNX_JOB_KEY);
    if (!saved) return;
    let cancelled = false;
    void (async () => {
      let status: KnxImportJobStatus | "gone" = "gone";
      let job: Awaited<ReturnType<typeof knxDiscoveryQueueJobStatus>> | null = null;
      try {
        job = await knxDiscoveryQueueJobStatus(saved);
        status = job.status;
      } catch {
        status = "gone"; // 404 (genuinely gone) or a transient error — either way, never block on it
      }
      if (cancelled) return;
      switch (resumeAction(status)) {
        case "scanning":
          setPhase("scanning");
          setJobId(saved); // hands off to the polling effect below
          break;
        case "done":
          if (job!.result) finishScan(job!.result);
          else localStorage.removeItem(KNX_JOB_KEY); // "completed" with no result shouldn't happen, but never resume garbage
          break;
        case "reset":
          localStorage.removeItem(KNX_JOB_KEY); // stale/dead — leave phase at "idle", button stays enabled
          break;
      }
    })();
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only recovery, intentionally
  }, []);

  useEffect(() => {
    if (!jobId) return;
    const activeJobId = jobId;
    let cancelled = false;
    // A transient poll failure (a network blip, a tab briefly backgrounded, or — since
    // KNX_JOB_KEY is one shared localStorage slot across every tab of this browser — a
    // sibling tab's own reload racing this one) must NOT be treated the same as "the job
    // genuinely no longer exists." Only a real 404 from the job-status endpoint means
    // that; anything else gets a bounded number of retries before giving up, so switching
    // tabs/briefly losing network doesn't make a perfectly-healthy background import look
    // like it "vanished."
    let consecutiveFailures = 0;
    const MAX_TRANSIENT_FAILURES = 5;
    async function poll() {
      try {
        const job = await knxDiscoveryQueueJobStatus(activeJobId);
        if (cancelled) return;
        consecutiveFailures = 0;
        setJobStatus(job.status);
        if (job.status === "completed" && job.result) {
          finishScan(job.result);
        } else if (job.status === "failed") {
          setError(job.error ?? "The import failed for an unknown reason.");
          setPhase("error");
          clearJob();
        } else if (job.status === "cancelled") {
          setPhase("idle");
          clearJob();
        } else {
          pollRef.current = setTimeout(() => void poll(), JOB_POLL_MS);
        }
      } catch (e) {
        if (cancelled) return;
        const definitelyGone = e instanceof HttpError && e.status === 404;
        consecutiveFailures += 1;
        if (definitelyGone || consecutiveFailures >= MAX_TRANSIENT_FAILURES) {
          // Either the gateway confirmed this job id is unknown (genuinely gone — jobs
          // are in-memory only, § job durability), or enough consecutive attempts failed
          // that this is no longer plausibly transient — surface that honestly.
          setError(e instanceof Error ? e.message : "Lost track of the import job.");
          setPhase("error");
          clearJob();
        } else {
          // Transient — keep the job tracked and retry rather than wiping the shared
          // localStorage key out from under every tab watching this import.
          pollRef.current = setTimeout(() => void poll(), JOB_POLL_MS);
        }
      }
    }
    void poll();
    return () => { cancelled = true; if (pollRef.current) clearTimeout(pollRef.current); };
  }, [jobId]);

  function clearJob() {
    localStorage.removeItem(KNX_JOB_KEY);
    setJobId(null);
    setJobStatus(null);
  }

  // § PASS 16 bug fix (scan result persistence) — this used to call clearJob() right here,
  // deleting the ONE piece of state (the job id in localStorage) that lets the mount-time
  // recovery effect above re-fetch a completed job's result. Since the backend keeps a
  // completed job's full result in memory indefinitely (nothing evicts it — see
  // getKnxImportJob's own doc comment in installer-context.ts), the fix is simply to stop
  // deleting our own reference to it: leave the job id in place so a later remount/refresh
  // still finds `saved`, calls knxDiscoveryQueueJobStatus(saved), sees status "completed"
  // with a `result`, and lands right back here — same review queue, nothing re-scanned.
  // The job reference is now cleared only by explicit user action (clearScanResults(),
  // "Clear results" below) or by starting a new scan, never automatically on success.
  function finishScan(out: Awaited<ReturnType<typeof knxDiscoveryQueue>>) {
    setResult(out);
    const initial: Record<string, { name: string; roomId: string }> = {};
    for (const item of out.queue) {
      const matchedRoom = rooms.find((r) => r.name.toLowerCase() === (item.room.room ?? "").toLowerCase());
      initial[item.device.backendId] = { name: item.device.suggestedName, roomId: matchedRoom?.id ?? "" };
    }
    setEdits(initial);
    setPhase("done");
  }

  // Deliberate, user-driven cleanup (§ job lifecycle) — the installer is done with this
  // review queue (everything they wanted approved/rejected) and wants a clean slate. Only
  // now does the completed job's reference actually get dropped.
  function clearScanResults() {
    clearJob();
    setResult(null);
    setEdits({});
    setApproved({});
    setSelected(new Set());
    setRejected(new Set());
    setPhase("idle");
  }

  async function cancelScan() {
    if (!jobId) return;
    try { await knxDiscoveryQueueJobCancel(jobId); } catch { /* best-effort — see cancellation doc */ }
    setPhase("idle");
    clearJob();
  }

  function onFile(file: File) {
    setNeedsPassword(false);
    setEtsPassword("");
    setEtsFileName(file.name);
    setSourceMode("project");
    if (file.name.toLowerCase().endsWith(".knxproj")) {
      setEtsFile(file);
      setEtsText("");
    } else {
      setEtsFile(null);
      void file.text().then((text) => setEtsText(text));
    }
  }

  function removeEtsFile() {
    setEtsFile(null);
    setEtsFileName(null);
    setEtsPassword("");
    setNeedsPassword(false);
    setSourceMode(null);
  }

  function clearPastedGa() {
    setEtsText("");
    setSourceMode(null);
  }

  // § Pass 11.2/11.3 — starts the NON-blocking job route and returns immediately; the
  // actual parse/synthesize/classify pipeline runs on the gateway in a real WORKER THREAD
  // (see startKnxImportJob → knxInstallerQueueThreaded in installer-context.ts), so the
  // hub keeps serving every other client while it runs — not just this browser tab, which
  // was never the part at risk. Progress is surfaced by the jobId effect above, which polls
  // GET .../job/:jobId until it lands on completed/failed/cancelled.
  async function scan() {
    setPhase("scanning");
    setError(null);
    setApproved({});
    setSelected(new Set());
    setRejected(new Set());
    // § live-confirmed fix — a real `.knxproj` upload over a slow/lossy connection can
    // take minutes even chunked (see api.ts's uploadKnxprojChunked), and the button's
    // default "Starting…" label would otherwise sit there with zero feedback the whole
    // time, indistinguishable from a genuine hang. `uploadProgress` covers exactly that
    // window (upload in flight, no jobId yet) with REAL chunk counts, not a guess.
    if (etsFile) setUploadProgress({ sent: 0, total: Math.max(1, Math.ceil(etsFile.size / KNX_UPLOAD_CHUNK_BYTES)) });
    try {
      const ets = etsFile
        ? { knxprojFile: etsFile, password: etsPassword || undefined }
        : etsText.trim()
          ? { content: etsText }
          : undefined;
      const started = await knxDiscoveryQueueJobStart(ets, (sent, total) => setUploadProgress({ sent, total }));
      localStorage.setItem(KNX_JOB_KEY, started.jobId);
      setJobId(started.jobId);
      setJobStatus(started.status);
    } catch (e) {
      const message = e instanceof Error ? e.message : "Discovery failed.";
      if (etsFile && /password/i.test(message)) setNeedsPassword(true);
      setError(message);
      setPhase("error");
    } finally {
      setUploadProgress(null);
    }
  }

  async function approve(item: KnxInstallerQueueItem) {
    const edit = edits[item.device.backendId] ?? { name: item.device.suggestedName, roomId: "" };
    setApproving(item.device.backendId);
    try {
      // roomId "" means Automatic — the Room Assignment Engine finds-or-creates a room
      // from the queue's own room hint (§ Automatic Room Creation), so there is nothing
      // to block approval on here anymore. NEW_ROOM_SENTINEL means the installer typed an
      // explicit new room name themselves, overriding whatever hint room-assignment found.
      const isNewRoom = edit.roomId === NEW_ROOM_SENTINEL;
      const roomNameHint = isNewRoom ? (edit.newRoomName?.trim() || undefined) : (item.room.room ?? undefined);
      const res = await approveKnxDevice({ device: item.device, name: edit.name, roomId: isNewRoom ? undefined : (edit.roomId || undefined), roomNameHint, plans: item.plans });
      setApproved((cur) => ({ ...cur, [item.device.backendId]: res }));
    } catch (e) {
      setApproved((cur) => ({ ...cur, [item.device.backendId]: { device: { id: "", name: edit.name }, status: "error", reason: e instanceof Error ? e.message : "Approval failed." } }));
    } finally {
      setApproving(null);
    }
  }

  async function approveMany(items: KnxInstallerQueueItem[]) {
    setBulkBusy(true);
    try {
      // Sequential, not Promise.all: each approval commissions + binds real hardware
      // addresses — running them concurrently risks racing the SAME duplicate-detection
      // state the backend just read for the previous item in this batch.
      for (const item of items) await approve(item);
    } finally {
      setBulkBusy(false);
    }
  }

  const queue = result?.queue ?? [];
  const bindableOf = (item: KnxInstallerQueueItem) => item.plans.length > 0 && item.plans.every((p) => p.bindable);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = queue.filter((item) => {
      const isRejected = rejected.has(item.device.backendId);
      const filters = itemFilters(item, isRejected);
      if (isRejected && !activeFilters.has("rejected")) return false;
      if (!isRejected && !filters.some((f) => f !== "rejected" && activeFilters.has(f))) return false;
      if (!q) return true;
      const edit = edits[item.device.backendId];
      const haystack = [
        edit?.name ?? item.device.suggestedName,
        item.room.room ?? "",
        item.device.raw.deviceKind,
        item.device.capabilities.join(" "),
        ...item.device.raw.communicationObjects.map((c) => c.id),
      ].join(" ").toLowerCase();
      return haystack.includes(q);
    });
    const sorted = [...filtered];
    switch (sortKey) {
      case "confidence":
        sorted.sort((a, b) => b.confidence.overall - a.confidence.overall);
        break;
      case "room":
        sorted.sort((a, b) => (a.room.room ?? "").localeCompare(b.room.room ?? ""));
        break;
      case "device_type":
        sorted.sort((a, b) => a.device.raw.deviceKind.localeCompare(b.device.raw.deviceKind));
        break;
      case "alphabetical":
        sorted.sort((a, b) => (edits[a.device.backendId]?.name ?? a.device.suggestedName).localeCompare(edits[b.device.backendId]?.name ?? b.device.suggestedName));
        break;
      case "discovery_order":
      default:
        break;
    }
    return sorted;
  }, [queue, query, activeFilters, rejected, sortKey, edits]);

  function toggleFilter(f: Filter) {
    setActiveFilters((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  }

  const selectableIds = visible.filter((i) => !approved[i.device.backendId] && !rejected.has(i.device.backendId)).map((i) => i.device.backendId);
  const selectedItems = visible.filter((i) => selected.has(i.device.backendId));

  return (
    <div className="drv-config">
      <h4>Discover devices</h4>
      <p className="muted">
        Scans the connected gateway and KNX IoT network, and/or an ETS project you provide below —
        the same Unified Device Intelligence pipeline either way: grouping, capability detection,
        room assignment, duplicate detection, and binding plans, using the schema selected above.
      </p>
      {sourceMode === null && (
        <div className="drv-field" style={{ marginTop: 4 }}>
          <span className="help">
            Optionally add an ETS source to merge into the same discovery pipeline — pick one:
          </span>
          <div className="drv-actions" style={{ marginTop: 8, display: "flex", gap: 8 }}>
            <button type="button" disabled={!canStartKnxScan(phase)} onClick={() => setSourceMode("project")}>
              Upload ETS project (.knxproj)
            </button>
            <button type="button" disabled={!canStartKnxScan(phase)} onClick={() => setSourceMode("pasted")}>
              Paste group-address export
            </button>
          </div>
        </div>
      )}
      {sourceMode === "project" && (
        <label className="drv-field" style={{ marginTop: 4 }}>
          <span className="lbl">ETS project</span>
          <input
            type="file"
            accept=".knxproj,.esf,.csv,.xml,text/xml,text/csv"
            disabled={!canStartKnxScan(phase)}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ""; }}
          />
          <span className="help">
            Upload a .knxproj. Imported devices go through this same review workspace — approve
            them exactly like a live-discovered device.
          </span>
          {etsFileName && (
            <div style={{ marginTop: 4, display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                className="muted"
                title={etsFileName}
                style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}
              >
                Selected: {etsFileName}
              </span>
              <button type="button" className="danger" disabled={phase === "scanning"} onClick={removeEtsFile} style={{ flexShrink: 0 }}>
                Remove
              </button>
            </div>
          )}
          {!etsFileName && (
            <button type="button" disabled={phase === "scanning"} onClick={() => setSourceMode(null)} style={{ marginTop: 4, alignSelf: "flex-start" }}>
              ‹ Choose a different source
            </button>
          )}
        </label>
      )}
      {sourceMode === "pasted" && (
        <div className="drv-field" style={{ marginTop: 4 }}>
          <span className="lbl">Group-address export (CSV/XML)</span>
          <textarea
            value={etsText}
            onChange={(e) => { setEtsText(e.target.value); setEtsFile(null); }}
            placeholder='e.g. <GroupAddress Name="Living Room - Ceiling - Switch" Address="1/1/1" DPTs="DPST-1-1" />'
            rows={4}
            style={{ width: "100%", fontFamily: "monospace", fontSize: 12, marginTop: 8 }}
          />
          <div style={{ marginTop: 4, display: "flex", gap: 8 }}>
            {etsText ? (
              <button type="button" className="danger" disabled={phase === "scanning"} onClick={clearPastedGa}>
                Clear pasted group addresses
              </button>
            ) : (
              <button type="button" disabled={phase === "scanning"} onClick={() => setSourceMode(null)}>
                ‹ Choose a different source
              </button>
            )}
          </div>
        </div>
      )}
      {needsPassword && etsFile && (
        <label className="drv-field" style={{ marginTop: 8 }}>
          <span className="lbl">Project password</span>
          <input type="password" value={etsPassword} onChange={(e) => setEtsPassword(e.target.value)} placeholder="ETS project password" />
        </label>
      )}
      <div className="drv-actions" style={{ marginTop: 8 }}>
        <button className="primary" disabled={!canStartKnxScan(phase)} onClick={() => void scan()}>
          {phase === "scanning"
            ? uploadProgress
              ? `Uploading project file… (${uploadProgress.sent}/${uploadProgress.total})`
              : jobStatusLabel(jobStatus)
            : result
              ? "Scan again"
              : "Discover devices"}
        </button>
        {phase === "scanning" && jobId && (
          <button className="danger" onClick={() => void cancelScan()} style={{ marginLeft: 8 }}>
            Cancel
          </button>
        )}
        {phase === "done" && result && (
          <button onClick={clearScanResults} style={{ marginLeft: 8 }} title="Dismiss this scan's review queue — approved devices are unaffected, already saved.">
            Clear results
          </button>
        )}
      </div>
      {phase === "scanning" && (
        <p className="muted" style={{ marginTop: 4 }}>
          {uploadProgress
            ? `Uploading the project file in small chunks (${uploadProgress.sent} of ${uploadProgress.total} sent) — a large project on a slow connection can take several minutes; this page will update once the upload finishes.`
            : "Running in the background — the import doesn't block the rest of the app; leave this page and come back, or refresh, and this will pick the same job back up."}
        </p>
      )}
      {phase === "error" && <p className="err">{error}</p>}

      {result && (
        <>
          <DiscoverySummary summary={result.summary} />

          <div className="knx-toolbar">
            <input
              className="knx-search"
              type="search"
              placeholder="Search by name, room, group address, device type…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>Sort: {SORT_LABEL[k]}</option>)}
            </select>
          </div>
          <div className="knx-filters">
            {FILTER_ORDER.map((f) => (
              <button
                key={f}
                type="button"
                className={`knx-filter-chip ${activeFilters.has(f) ? "active" : ""}`}
                onClick={() => toggleFilter(f)}
              >
                {FILTER_LABEL[f]}
              </button>
            ))}
          </div>

          <div className="knx-bulk-bar">
            <button type="button" className="link" onClick={() => setSelected(new Set(selectableIds))}>Select all</button>
            <button type="button" className="link" onClick={() => setSelected(new Set())}>Clear selection</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "ready" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select ready</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "needs_review" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select needs review</button>
            <button type="button" className="link" onClick={() => setSelected(new Set(visible.filter((i) => i.section === "duplicates" && selectableIds.includes(i.device.backendId)).map((i) => i.device.backendId)))}>Select duplicates</button>
            <span className="muted">{selected.size} selected</span>
            <button
              type="button"
              className="primary"
              disabled={bulkBusy || selectedItems.length === 0}
              onClick={() => void approveMany(selectedItems.filter(bindableOf))}
            >
              {bulkBusy ? "Approving…" : "Approve selected"}
            </button>
            <button
              type="button"
              disabled={bulkBusy || selectedItems.length === 0}
              onClick={() => { setRejected((cur) => new Set([...cur, ...selectedItems.map((i) => i.device.backendId)])); setSelected(new Set()); }}
            >
              Reject selected
            </button>
            <button
              type="button"
              className="primary"
              disabled={bulkBusy}
              onClick={() => void approveMany(visible.filter((i) => i.section === "ready" && bindableOf(i) && !approved[i.device.backendId] && !rejected.has(i.device.backendId)))}
            >
              Approve all ready
            </button>
          </div>

          <div className="knx-device-list">
            {visible.map((item) => (
              <DeviceCard
                key={item.device.backendId}
                item={item}
                rooms={rooms}
                edit={edits[item.device.backendId] ?? { name: item.device.suggestedName, roomId: rooms[0]?.id ?? "" }}
                onEdit={(patch) => setEdits((cur) => ({ ...cur, [item.device.backendId]: { ...cur[item.device.backendId]!, ...patch } }))}
                approval={approved[item.device.backendId]}
                busy={approving === item.device.backendId}
                onApprove={() => approve(item)}
                selected={selected.has(item.device.backendId)}
                onToggleSelect={() => setSelected((cur) => { const next = new Set(cur); if (next.has(item.device.backendId)) next.delete(item.device.backendId); else next.add(item.device.backendId); return next; })}
                rejected={rejected.has(item.device.backendId)}
                onReject={() => setRejected((cur) => new Set([...cur, item.device.backendId]))}
                onUnreject={() => setRejected((cur) => { const next = new Set(cur); next.delete(item.device.backendId); return next; })}
                schemaUsed={result.summary.groupAddressSchema}
              />
            ))}
          </div>
          {visible.length === 0 && <p className="muted">No devices match the current search/filters.</p>}
          {result.queue.length === 0 && <p className="muted">No devices discovered — check the gateway connection or import an ETS project above first.</p>}
        </>
      )}
    </div>
  );
}

function DiscoverySummary({ summary }: { summary: NonNullable<Awaited<ReturnType<typeof knxDiscoveryQueue>>["summary"]> }) {
  const stats: [string, string | number][] = [
    ["Total group addresses", summary.totalGroupAddresses],
    ["Communication objects", summary.communicationObjects],
    ["Circuits created", summary.circuitsCreated],
    ["Devices generated", summary.devicesCreated],
    ["Ready to approve", summary.readyCount],
    ["Needs review", summary.needsReviewCount],
    ["Duplicate circuits", summary.duplicateCircuits],
    ["Unsupported objects", summary.unsupportedObjects],
    ["Discovery duration", `${summary.discoveryDurationMs} ms`],
    ["Group Address Schema", summary.groupAddressSchema],
  ];
  return (
    <div className="knx-summary">
      {stats.map(([label, value]) => (
        <div key={label} className="knx-summary-stat">
          <div className="knx-summary-value">{value}</div>
          <div className="knx-summary-label">{label}</div>
        </div>
      ))}
    </div>
  );
}

function DeviceCard({
  item, rooms, edit, onEdit, approval, busy, onApprove, selected, onToggleSelect, rejected, onReject, onUnreject, schemaUsed,
}: {
  item: KnxInstallerQueueItem;
  rooms: { id: string; name: string }[];
  edit: { name: string; roomId: string; newRoomName?: string };
  onEdit: (patch: Partial<{ name: string; roomId: string; newRoomName: string }>) => void;
  approval?: KnxApprovalResult;
  busy: boolean;
  onApprove: () => void;
  selected: boolean;
  onToggleSelect: () => void;
  rejected: boolean;
  onReject: () => void;
  onUnreject: () => void;
  schemaUsed: string;
}) {
  const [showWhy, setShowWhy] = useState(false);
  const bindable = item.plans.length > 0 && item.plans.every((p) => p.bindable);

  return (
    <div className={`knx-device-card ${rejected ? "rejected" : ""}`}>
      <div className="knx-device-head">
        {!approval && !rejected && (
          <input type="checkbox" checked={selected} onChange={onToggleSelect} aria-label={`Select ${edit.name}`} />
        )}
        <input className="knx-device-name" value={edit.name} onChange={(e) => onEdit({ name: e.target.value })} disabled={!!approval || rejected} />
        <span className={`drv-badge ${item.confidence.overall >= 85 ? "ok" : item.confidence.overall >= 70 ? "" : "err"}`}>{item.confidence.overall}% confidence</span>
      </div>
      <div className="knx-device-meta">
        {item.device.raw.classification.category} → {item.device.raw.classification.type} · {capabilityDisplayLabels(item.device.capabilities, item.plans).join(", ") || "no capability detected"} · {item.device.raw.communicationObjects.length} communication object{item.device.raw.communicationObjects.length === 1 ? "" : "s"} · {item.duplicate.decision}
      </div>
      <label className="knx-device-room">
        Room
        <select
          value={edit.roomId}
          onChange={(e) => onEdit({ roomId: e.target.value, ...(e.target.value === NEW_ROOM_SENTINEL ? { newRoomName: edit.newRoomName ?? item.room.room ?? "" } : {}) })}
          disabled={!!approval || rejected}
        >
          <option value="">Automatic{item.room.room ? ` (${item.room.room})` : " (Unassigned)"}</option>
          {rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          <option value={NEW_ROOM_SENTINEL}>+ Add new room…</option>
        </select>
        {edit.roomId === NEW_ROOM_SENTINEL && (
          <input
            type="text"
            className="knx-device-new-room"
            placeholder="New room name"
            value={edit.newRoomName ?? ""}
            onChange={(e) => onEdit({ newRoomName: e.target.value })}
            disabled={!!approval || rejected}
            style={{ marginTop: 4 }}
          />
        )}
      </label>

      <button type="button" className="link" onClick={() => setShowWhy((s) => !s)}>{showWhy ? "Hide explanation" : "Why was this device created?"}</button>
      {showWhy && (
        <div className="knx-explain">
          <div><strong>Circuit:</strong> {item.device.raw.groupingKey}</div>
          <div><strong>Classification:</strong> {item.device.raw.classification.category} → {item.device.raw.classification.type} ({item.device.raw.classification.confidence}% confidence) — {item.device.raw.classification.reason}</div>
          <div><strong>Canonical detail page:</strong> {item.device.raw.classification.canonicalDetailPage}</div>
          <div><strong>Grouping/schema used:</strong> {schemaUsed}</div>
          <div><strong>Merge decisions:</strong> {item.device.raw.mergeExplanation.join("; ") || "none recorded"}</div>
          <div><strong>Capability reasoning:</strong> {item.device.capabilities.length > 0 ? `${item.device.capabilities.join(", ")} detected from communication object datapoint types` : "no communication object mapped to a known capability"}</div>
          <div><strong>Room:</strong> {item.room.room ?? "unassigned"} — {item.room.reason}</div>
          <div><strong>Confidence breakdown:</strong> name {item.confidence.name}% · room {item.confidence.room}% · capability {item.confidence.capability}% · grouping {item.confidence.grouping}% · manufacturer {item.confidence.manufacturer}% · model {item.confidence.model}%</div>
          <div><strong>Duplicate reasoning:</strong> {item.duplicate.reason}{item.duplicate.matchedOn ? ` (matched on ${item.duplicate.matchedOn})` : ""}</div>
          {!bindable && <div className="err"><strong>Binding:</strong> {item.plans.map((p) => p.reason).join("; ") || "no communication objects to bind"}</div>}
        </div>
      )}

      <div className="drv-actions" style={{ marginTop: 8 }}>
        {rejected ? (
          <>
            <span className="drv-badge err">Rejected</span>
            <button type="button" className="link" onClick={onUnreject}>Undo</button>
          </>
        ) : !approval ? (
          <>
            <button className="primary" disabled={busy || !bindable} onClick={onApprove}>
              {busy ? "Approving…" : bindable ? "Approve" : "Not bindable"}
            </button>
            <button type="button" onClick={onReject}>Reject</button>
          </>
        ) : (
          <span className={`drv-badge ${approval.status === "ready" ? "ok" : approval.status === "warning" ? "" : "err"}`}>
            {approval.status === "ready" ? "Commissioned" : approval.status === "warning" ? "Commissioned (unverified)" : "Failed"}
            {approval.reason ? ` — ${approval.reason}` : ""}
          </span>
        )}
      </div>
    </div>
  );
}
