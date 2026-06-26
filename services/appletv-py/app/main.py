"""FastAPI bridge exposing pyatv-backed Apple TV control to the Node driver.

The Node `AppleTvProtocolDriver` (in `@supreme/protocols`) drives a tvOS device
through this HTTP surface: discover, run the one-time PIN pairing, then per-device
control + "now playing" (foreground app + content). Pairing credentials live here
(persisted to the data volume), so the hub never holds Apple secrets in Node.

Surface:
  GET  /healthz
  GET  /scan                              — discover Apple TVs on the LAN (mDNS)
  POST /pair/begin   {address, protocol}  — start PIN pairing (device shows a code)
  POST /pair/pin     {session_id, pin}    — submit the code; stores credentials
  POST /connect      {address}            — open a control session (uses stored creds)
  POST /disconnect   {address}
  POST /devices/{address}/command {action, volume?}
  GET  /devices/{address}/now_playing
"""

from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException

from .backend import AppleTvBackend, AppleTvError, make_backend
from .models import (
    CommandRequest,
    ConnectRequest,
    PairBeginRequest,
    PairPinRequest,
)

app = FastAPI(title="Supreme Apple TV Bridge", version="0.0.1")

_backend: AppleTvBackend = make_backend()


def get_backend() -> AppleTvBackend:
    # Indirection so tests can override with `app.dependency_overrides`.
    return _backend


@app.get("/healthz")
def healthz(backend: AppleTvBackend = Depends(get_backend)) -> dict:
    return {"status": "ok", "service": "appletv", "paired": backend.paired_addresses()}


@app.get("/scan")
async def scan(backend: AppleTvBackend = Depends(get_backend)) -> dict:
    devices = await _guard(backend.scan())
    return {"devices": [d.to_dict() for d in devices]}


@app.post("/pair/begin")
async def pair_begin(
    req: PairBeginRequest, backend: AppleTvBackend = Depends(get_backend)
) -> dict:
    session_id = await _guard(backend.pair_begin(req.address, req.protocol))
    return {"session_id": session_id, "device_provides_pin": True}


@app.post("/pair/pin")
async def pair_pin(req: PairPinRequest, backend: AppleTvBackend = Depends(get_backend)) -> dict:
    protocols = await _guard(backend.pair_pin(req.session_id, req.pin))
    return {"paired": True, "protocols": protocols}


@app.post("/connect")
async def connect(req: ConnectRequest, backend: AppleTvBackend = Depends(get_backend)) -> dict:
    await _guard(backend.connect(req.address))
    return {"address": req.address, "connected": True}


@app.post("/disconnect")
async def disconnect(req: ConnectRequest, backend: AppleTvBackend = Depends(get_backend)) -> dict:
    await _guard(backend.disconnect(req.address))
    return {"address": req.address, "connected": False}


@app.post("/devices/{address}/command")
async def command(
    address: str, req: CommandRequest, backend: AppleTvBackend = Depends(get_backend)
) -> dict:
    await _guard(backend.command(address, req.action, req.volume))
    return {"ok": True}


@app.get("/devices/{address}/now_playing")
async def now_playing(address: str, backend: AppleTvBackend = Depends(get_backend)) -> dict:
    np = await _guard(backend.now_playing(address))
    return np.to_dict()


async def _guard(awaitable):
    """Translate backend errors into HTTP 400s with a clean message."""
    try:
        return await awaitable
    except AppleTvError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
