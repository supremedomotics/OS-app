"""Real-LLM tests — exercised only when a GGUF model is provisioned.

Skipped in CI / environments without weights (the deterministic planner is covered
by test_plan.py). When SUPREME_AI_MODEL_PATH points at a model and llama-cpp-python
is installed, this verifies the on-box model actually loads and returns a
structurally + referentially valid draft (or correctly yields None to fall back).
"""

from __future__ import annotations

import os

import pytest

_HAS_MODEL = bool(os.environ.get("SUPREME_AI_MODEL_PATH")) and os.path.exists(
    os.environ.get("SUPREME_AI_MODEL_PATH", "")
)
try:
    import llama_cpp  # noqa: F401

    _HAS_RUNTIME = True
except Exception:
    _HAS_RUNTIME = False

pytestmark = pytest.mark.skipif(
    not (_HAS_MODEL and _HAS_RUNTIME),
    reason="no on-box model (set SUPREME_AI_MODEL_PATH) / llama-cpp-python not installed",
)

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


def test_model_loads_and_available():
    from app.llm import available

    assert available() is True


def test_llm_draft_is_valid_or_none():
    from app.llm import plan_llm

    result = plan_llm("dim the living room lights to 20%", CTX)
    # Either a structurally valid draft, or None (the service then falls back).
    if result is not None:
        assert result["kind"] in {"actions", "scene", "automation", "answer"}
        ids = {d["id"] for d in CTX["devices"]}
        for item in result.get("commands", []) + result.get("steps", []):
            assert item["deviceId"] in ids
