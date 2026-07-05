# Supreme Commissioning (Python protocol tooling)

The Python side of commissioning (blueprint §4): low-level **KNX / DALI / Modbus**
bus scanning. It exposes a tiny HTTP API that the Node commissioning orchestrator
(`@supreme/commissioning`, via `HttpProtocolScanner`) calls over loopback; results
are normalized into Supreme capabilities, so protocol detail never leaks above the
Supreme Integration Layer.

```
GET /healthz            → { status, protocols: [...] }
GET /scan/{protocol}    → { protocol, devices: [ { backend_id, name, capabilities } ] }
```

Phase 2 ships deterministic **simulators** so commissioning wizards work without
hardware. Real scanners (`xknx`, `python-dali`, `pymodbus`) drop in behind the same
`scan()` signature in `app/simulators.py`.

## Develop

```bash
uv sync            # or: pip install -e '.[dev]'
uvicorn app.main:app --reload --port 9100
uv run pytest
```

The hub runs this as a sidecar container (see `infra/hub-compose`); the gateway
points `SUPREME_COMMISSIONING_URL` at it.
