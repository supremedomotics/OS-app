"""Bridge API tests against the fake backend (no pyatv / no hardware).

Exercises the full Node↔bridge contract: discover → pair (PIN) → connect →
control → now-playing, plus the error paths the Node client relies on.
"""

from fastapi.testclient import TestClient

from app.backend import FakeBackend
from app.main import app, get_backend

fake = FakeBackend()
app.dependency_overrides[get_backend] = lambda: fake
client = TestClient(app)


def test_healthz_lists_paired():
    res = client.get("/healthz")
    assert res.status_code == 200
    assert res.json()["service"] == "appletv"


def test_scan_finds_the_apple_tv():
    res = client.get("/scan")
    assert res.status_code == 200
    devices = res.json()["devices"]
    assert any(d["address"] == "10.0.0.42" and d["name"] == "Living Room" for d in devices)


def test_pairing_flow_then_control_and_now_playing():
    # 1. Begin pairing — device "shows a PIN".
    begin = client.post("/pair/begin", json={"address": "10.0.0.42", "protocol": "airplay"})
    assert begin.status_code == 200
    session_id = begin.json()["session_id"]

    # 2. Submit the PIN — credentials get stored.
    pin = client.post("/pair/pin", json={"session_id": session_id, "pin": "1234"})
    assert pin.status_code == 200
    assert pin.json()["protocols"] == ["airplay"]
    assert "10.0.0.42" in client.get("/healthz").json()["paired"]

    # 3. Connect a control session.
    assert client.post("/connect", json={"address": "10.0.0.42"}).status_code == 200

    # 4. Drive transport + volume + mute.
    for body in (
        {"action": "play"},
        {"action": "volume", "volume": 70},
        {"action": "mute"},
    ):
        assert client.post("/devices/10.0.0.42/command", json=body).status_code == 200

    # 5. Now-playing reflects the foreground app + content + the commands.
    np = client.get("/devices/10.0.0.42/now_playing").json()
    assert np["state"] == "playing"
    assert np["app"] == "Netflix"
    assert np["title"] == "The Crown"
    assert np["volume"] == 70
    assert np["muted"] is True


def test_bad_pin_is_rejected():
    begin = client.post("/pair/begin", json={"address": "10.0.0.42"})
    sid = begin.json()["session_id"]
    res = client.post("/pair/pin", json={"session_id": sid, "pin": "12"})
    # 12 fails pydantic's min_length (422) — too short to even reach the backend.
    assert res.status_code == 422


def test_command_before_connect_is_an_error():
    # A fresh device that was never connected rejects control.
    res = client.post("/devices/10.0.0.99/command", json={"action": "play"})
    assert res.status_code == 400


def test_unknown_now_playing_is_an_error():
    res = client.get("/devices/10.0.0.99/now_playing")
    assert res.status_code == 400
