from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz_lists_protocols():
    res = client.get("/healthz")
    assert res.status_code == 200
    assert "knx" in res.json()["protocols"]


def test_scan_knx_returns_capability_hints():
    res = client.get("/scan/knx")
    assert res.status_code == 200
    devices = res.json()["devices"]
    assert any(d["backend_id"] == "knx.1_1_1" for d in devices)
    assert "brightness" in devices[0]["capabilities"]


def test_unknown_protocol_is_empty():
    res = client.get("/scan/zwave")
    assert res.status_code == 200
    assert res.json()["devices"] == []
