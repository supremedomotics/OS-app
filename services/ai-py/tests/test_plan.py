from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

CTX = {
    "rooms": [{"id": "room_living", "name": "Living Room"}],
    "devices": [
        {
            "id": "dev_living_lights",
            "name": "Living Room Lights",
            "roomId": "room_living",
            "supremeType": "dimmer",
            "capabilities": ["onoff", "brightness"],
        }
    ],
}


def test_healthz():
    assert client.get("/healthz").json()["status"] == "ok"


def test_plan_dim():
    res = client.post(
        "/plan",
        json={"utterance": "dim the living room lights to 25%", "context": CTX},
    )
    body = res.json()
    assert body["kind"] == "actions"
    assert body["commands"][0]["command"] == {
        "capability": "brightness",
        "action": "set",
        "level": 25,
    }


def test_plan_answer_fallback():
    res = client.post("/plan", json={"utterance": "hello there", "context": CTX})
    assert res.json()["kind"] == "answer"
