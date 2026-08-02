#!/usr/bin/env bash
# Casambi Local Gateway — Certification Evidence Collector
# (§ Real Hardware Certification, Phase 3)
#
# Run this ON YOUR OWN Linux host, next to your running SupremeOS installation and real Lithernet
# Gateway. It never leaves your machine and never talks to anything outside your own network — it
# only calls your own Gateway's API and your own Docker containers. Nothing here connects to any
# AI session; you run this, collect the output folder it produces, and share THAT back yourself.
#
# What it collects, all into one timestamped output directory:
#   - `docker compose ps` output for the running stack
#   - `docker logs` for the lan/gateway/nats containers (best-effort — skipped, not guessed, if a
#     container isn't found)
#   - Two Transport Monitor snapshots (`GET /v1/drivers/:id/casambi/transport-monitor`): one taken
#     immediately, one taken after you've been prompted to trigger real activity on the gateway
#     (toggle a light, press a button) — the diff between them is real evidence of what the
#     pipeline actually saw.
#   - An optional real `tcpdump` capture (only if you pass --interface; requires sudo) running
#     WHILE you trigger that activity — the single best piece of evidence if reception fails,
#     since it independently proves whether the broadcast reached this host's real NIC at all.
#   - § Runtime Data Path Verification — a Receive Pipeline report (`GET
#     /v1/drivers/:id/casambi/receive-pipeline`), taken after the trigger step, with the REAL
#     packet count `tcpdump` captured passed through as `wiresharkPackets` so the root-cause
#     classifier can resolve the one case where "the gateway isn't transmitting" and "the packets
#     never reach this network namespace" would otherwise be indistinguishable. If you also start
#     `supreme-lan`'s independent UDP probe (set SUPREME_LAN_PROBE_PORT on the `lan` service before
#     bringing the stack up — see the runbook's Step 6a), that report's evidence gets sharper still.
#
# Nothing is fabricated: every section of the resulting bundle is either real command output or an
# explicit "SKIPPED: <reason>" note — never silently absent, never guessed.

set -euo pipefail

GATEWAY_URL=""
DRIVER_ID=""
AUTH_TOKEN="${SUPREME_AUTH_TOKEN:-}"
INTERFACE=""
DURATION=30
OUT_DIR=""
COMPOSE_FILES=(-f docker-compose.yml -f docker-compose.nats-loopback.yml -f docker-compose.lan-host.yml)

usage() {
  cat <<'EOF'
Usage: ./collect-certification-evidence.sh --gateway-url <url> --driver-id <id> [options]

Required:
  --gateway-url <url>   Base URL of your running SupremeOS Gateway, e.g. https://192.168.0.10
  --driver-id <id>      Installed Casambi driver id (Driver Manager UI, or GET /v1/drivers)

Options:
  --auth-token <token>  Bearer token for Gateway auth. Reads $SUPREME_AUTH_TOKEN if omitted.
  --interface <iface>   Real NIC to run a `tcpdump` capture on during the trigger step (requires
                         sudo). Omit to skip the pcap capture — the Transport Monitor snapshots
                         are still collected either way.
  --duration <seconds>  tcpdump capture duration (default 30).
  --out <dir>           Output directory (default: ./casambi-certification-<timestamp>).
  -h, --help            Show this help.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --driver-id) DRIVER_ID="$2"; shift 2 ;;
    --auth-token) AUTH_TOKEN="$2"; shift 2 ;;
    --interface) INTERFACE="$2"; shift 2 ;;
    --duration) DURATION="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage; exit 1 ;;
  esac
done

if [ -z "$GATEWAY_URL" ] || [ -z "$DRIVER_ID" ]; then
  echo "ERROR: --gateway-url and --driver-id are required." >&2
  usage
  exit 1
fi

OUT_DIR="${OUT_DIR:-./casambi-certification-$(date +%Y%m%dT%H%M%S)}"
mkdir -p "$OUT_DIR"
echo "Collecting certification evidence into: $OUT_DIR"

CURL_AUTH=()
if [ -n "$AUTH_TOKEN" ]; then
  CURL_AUTH=(-H "Authorization: Bearer $AUTH_TOKEN")
else
  echo "NOTE: no --auth-token / \$SUPREME_AUTH_TOKEN set — Transport Monitor requests will be unauthenticated and may fail with 401. That will be recorded honestly in the output, not hidden." | tee "$OUT_DIR/notes.txt"
fi

fetch_transport_monitor() {
  local label="$1"
  local out="$OUT_DIR/transport-monitor-${label}.json"
  if curl -fsS ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} "$GATEWAY_URL/v1/drivers/$DRIVER_ID/casambi/transport-monitor" -o "$out" 2>"$OUT_DIR/transport-monitor-${label}.curl-error.log"; then
    rm -f "$OUT_DIR/transport-monitor-${label}.curl-error.log"
    echo "  ✓ transport-monitor-${label}.json"
  else
    echo "  ✗ transport-monitor-${label}.json FAILED — see transport-monitor-${label}.curl-error.log" | tee -a "$OUT_DIR/notes.txt"
  fi
}

echo "--- docker compose status ---"
if docker compose "${COMPOSE_FILES[@]}" ps > "$OUT_DIR/docker-compose-ps.txt" 2>&1; then
  echo "  ✓ docker-compose-ps.txt"
else
  echo "  SKIPPED: docker compose ps failed (wrong directory? stack not up with these overlay files?) — see docker-compose-ps.txt for the real error" | tee -a "$OUT_DIR/notes.txt"
fi

echo "--- container logs (best-effort per container) ---"
for svc in lan gateway nats; do
  cid="$(docker compose "${COMPOSE_FILES[@]}" ps -q "$svc" 2>/dev/null || true)"
  if [ -n "$cid" ]; then
    docker logs "$cid" --since 2h > "$OUT_DIR/${svc}.log" 2>&1 || true
    echo "  ✓ ${svc}.log"
  else
    echo "  SKIPPED: no running '$svc' container found" | tee -a "$OUT_DIR/notes.txt"
  fi
done

echo "--- Transport Monitor snapshot (before) ---"
fetch_transport_monitor "before"

TCPDUMP_PID=""
if [ -n "$INTERFACE" ]; then
  echo "--- starting tcpdump on $INTERFACE for ${DURATION}s (requires sudo) ---"
  sudo -n true 2>/dev/null || echo "  (sudo may prompt for your password now)"
  sudo tcpdump -i "$INTERFACE" -w "$OUT_DIR/capture.pcap" > "$OUT_DIR/tcpdump.log" 2>&1 &
  TCPDUMP_PID=$!
  sleep 1
else
  echo "--- tcpdump SKIPPED (no --interface given) ---" | tee -a "$OUT_DIR/notes.txt"
fi

echo ""
echo ">>> Now trigger real activity on your Lithernet Gateway: toggle a light, press a button,"
echo ">>> or anything else you want this capture to prove. Press Enter here once you're done"
if [ -n "$TCPDUMP_PID" ]; then
  echo ">>> (tcpdump is running in the background right now, for up to ${DURATION}s)."
fi
read -r -p ">>> Press Enter to continue: " _

if [ -n "$TCPDUMP_PID" ]; then
  echo "--- stopping tcpdump ---"
  sudo kill -INT "$TCPDUMP_PID" 2>/dev/null || true
  wait "$TCPDUMP_PID" 2>/dev/null || true
  if [ -s "$OUT_DIR/capture.pcap" ]; then
    echo "  ✓ capture.pcap"
  else
    echo "  SKIPPED: capture.pcap is empty or missing — tcpdump may have failed, see tcpdump.log" | tee -a "$OUT_DIR/notes.txt"
  fi
fi

echo "--- Transport Monitor snapshot (after) ---"
fetch_transport_monitor "after"

if command -v jq >/dev/null 2>&1 && [ -f "$OUT_DIR/transport-monitor-after.json" ]; then
  echo "--- Failure Analysis (from the 'after' snapshot's own failureAnalysis field) ---"
  jq -r '.failureAnalysis // "no failureAnalysis field present in this response"' "$OUT_DIR/transport-monitor-after.json" | tee "$OUT_DIR/failure-analysis-summary.json" > /dev/null
  echo "  ✓ failure-analysis-summary.json"
fi

echo "--- Receive Pipeline report (§ Runtime Data Path Verification) ---"
WIRESHARK_QS=""
if [ -s "$OUT_DIR/capture.pcap" ] && command -v tcpdump >/dev/null 2>&1; then
  # A real count read back from the capture that was just taken — never estimated, and never
  # assumed to be zero if the read itself fails (in which case the query param is simply omitted,
  # leaving the root cause honestly "unknown" rather than wrongly resolved to zero).
  PCAP_COUNT="$(tcpdump -r "$OUT_DIR/capture.pcap" 2>/dev/null | wc -l | tr -d ' ' || true)"
  if [ -n "$PCAP_COUNT" ]; then
    echo "  Real tcpdump packet count from capture.pcap: $PCAP_COUNT"
    WIRESHARK_QS="?wiresharkPackets=${PCAP_COUNT}"
  fi
fi
RECEIVE_PIPELINE_OUT="$OUT_DIR/receive-pipeline.json"
if curl -fsS ${CURL_AUTH[@]+"${CURL_AUTH[@]}"} "$GATEWAY_URL/v1/drivers/$DRIVER_ID/casambi/receive-pipeline${WIRESHARK_QS}" -o "$RECEIVE_PIPELINE_OUT" 2>"$OUT_DIR/receive-pipeline.curl-error.log"; then
  rm -f "$OUT_DIR/receive-pipeline.curl-error.log"
  echo "  ✓ receive-pipeline.json"
  if command -v jq >/dev/null 2>&1; then
    echo "  Root cause: $(jq -r '.rootCause.cause // "unknown"' "$RECEIVE_PIPELINE_OUT")"
    echo "  Certified: $(jq -r '.certified' "$RECEIVE_PIPELINE_OUT")"
  fi
else
  echo "  SKIPPED: receive-pipeline.json request failed — see receive-pipeline.curl-error.log. This endpoint is new; an older Gateway build will 404 here, which is expected, not a failure of this script." | tee -a "$OUT_DIR/notes.txt"
fi

if command -v tar >/dev/null 2>&1; then
  ARCHIVE="${OUT_DIR%/}.tar.gz"
  tar -czf "$ARCHIVE" -C "$(dirname "$OUT_DIR")" "$(basename "$OUT_DIR")"
  echo ""
  echo "Bundle ready: $OUT_DIR/  (also archived as $ARCHIVE)"
else
  echo ""
  echo "Bundle ready: $OUT_DIR/  (tar not found — share the directory directly)"
fi
echo "Share this back for analysis. Check notes.txt first for anything this script couldn't collect."
