"""FastAPI app exposing protocol scans to the Node commissioning orchestrator."""

from __future__ import annotations

from fastapi import FastAPI

from .simulators import SCANNERS, scan

app = FastAPI(title="Supreme Commissioning", version="0.0.1")


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "protocols": sorted(SCANNERS.keys())}


@app.get("/scan/{protocol}")
def scan_protocol(protocol: str) -> dict:
    """Scan a protocol bus and return discovered devices with capability hints.

    The response shape matches what `HttpProtocolScanner` (Node) expects:
    `{ "devices": [ { backend_id, name, capabilities } ] }`.
    """
    devices = scan(protocol)
    return {"protocol": protocol, "devices": [d.to_dict() for d in devices]}
