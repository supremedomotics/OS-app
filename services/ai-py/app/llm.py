"""Real on-box LLM planner (llama.cpp) — §10.

Loads a local GGUF instruct model via `llama-cpp-python` and converts a natural
language request + home context into a Supreme DSL draft, with JSON-constrained
decoding so the output is always parseable. The model is provisioned to the
appliance (never shipped in-repo) via `SUPREME_AI_MODEL_PATH`; when it is absent or
the runtime isn't installed, callers fall back to the deterministic planner — so
the assistant always works, with or without weights.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any, Optional

_MODEL: Any = None
_LOAD_FAILED = False

SYSTEM_PROMPT = (
    "You are Supreme's on-box smart-home assistant. Convert the user's request into "
    "a single JSON object describing a DRAFT the user will confirm. Use ONLY device "
    "ids from the provided list, copied EXACTLY. Choose the device whose name best "
    "matches the request. Schema:\n"
    '{"kind":"actions","summary":str,"commands":[{"deviceId":str,"command":'
    '{"capability":"onoff|brightness|position|lock","action":str,"level":int?}}]}\n'
    'or {"kind":"scene","summary":str,"name":str,"steps":[{"deviceId":str,'
    '"capability":str,"values":{}}]}\n'
    'or {"kind":"automation","summary":str,"name":str,"triggers":[...],"actions":[...]}\n'
    'or {"kind":"answer","summary":str}\n'
    "Rules: brightness uses action 'set' with level 0-100; on/off use action "
    "'on'/'off'; locks use 'lock'/'unlock'; covers use 'open'/'close'. Respond with "
    "JSON only, no prose.\n"
    "Example — devices: [id=dev_abc name=\"Kitchen Lights\" capabilities=['onoff','brightness']]; "
    'request "turn the kitchen lights to 50%" → '
    '{"kind":"actions","summary":"Kitchen Lights to 50%","commands":'
    '[{"deviceId":"dev_abc","command":{"capability":"brightness","action":"set","level":50}}]}'
)


def _load() -> Any:
    """Lazily load the GGUF model once; returns None when unavailable."""
    global _MODEL, _LOAD_FAILED
    if _MODEL is not None or _LOAD_FAILED:
        return _MODEL
    path = os.environ.get("SUPREME_AI_MODEL_PATH")
    if not path or not os.path.exists(path):
        _LOAD_FAILED = True
        return None
    try:
        from llama_cpp import Llama  # imported lazily; optional dependency

        _MODEL = Llama(
            model_path=path,
            n_ctx=int(os.environ.get("SUPREME_AI_CTX", "2048")),
            n_threads=os.cpu_count() or 4,
            verbose=False,
        )
    except Exception:
        _LOAD_FAILED = True
        _MODEL = None
    return _MODEL


def available() -> bool:
    return _load() is not None


def plan_llm(utterance: str, ctx: dict) -> Optional[dict]:
    """Return a validated draft from the local model, or None to fall back."""
    llm = _load()
    if llm is None:
        return None

    device_lines = "\n".join(
        f'- id={d["id"]} name="{d["name"]}" capabilities={d["capabilities"]}'
        for d in ctx.get("devices", [])
    )
    user = f"Devices:\n{device_lines}\n\nRequest: {utterance}"
    try:
        out = llm.create_chat_completion(
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": user},
            ],
            response_format={"type": "json_object"},  # JSON-constrained decoding
            temperature=0.1,
            max_tokens=512,
        )
        text = out["choices"][0]["message"]["content"]
        data = json.loads(text)
    except Exception:
        return None

    return data if _valid(data, ctx, utterance) else None


# Generic words in device names that don't help confirm a match.
_STOPWORDS = {"the", "a", "room", "light", "lights", "supreme", "of", "and"}


def _mentioned(device: dict, utterance: str) -> bool:
    """Heuristic: is this device plausibly referenced by the utterance? Guards a
    small model against hallucinating an unrelated device."""
    u = utterance.lower()
    name = device["name"].lower()
    if name in u:
        return True
    tokens = [t for t in name.replace("-", " ").split() if len(t) > 2 and t not in _STOPWORDS]
    return any(t in u for t in tokens)


def _valid(data: Any, ctx: dict, utterance: str) -> bool:
    """Validate the model's draft structurally, referentially, AND plausibly:
    every referenced device id must exist and be plausibly named in the request
    (unless the request targets "all"/"every"). Anything else falls back to the
    deterministic planner."""
    if not isinstance(data, dict):
        return False
    kind = data.get("kind")
    if kind not in {"actions", "scene", "automation", "answer"}:
        return False
    by_id = {d["id"]: d for d in ctx.get("devices", [])}
    broad = bool(re.search(r"\b(all|every|everything)\b", utterance.lower()))

    def refs_ok(items: Any, key: str) -> bool:
        if not isinstance(items, list) or not items:
            return False
        for it in items:
            if not isinstance(it, dict):
                return False
            dev = by_id.get(it.get(key))
            if dev is None:
                return False
            if not broad and not _mentioned(dev, utterance):
                return False
        return True

    if kind == "actions":
        return refs_ok(data.get("commands"), "deviceId")
    if kind == "scene":
        return isinstance(data.get("name"), str) and refs_ok(data.get("steps"), "deviceId")
    if kind == "automation":
        return isinstance(data.get("name"), str) and isinstance(data.get("actions"), list)
    return isinstance(data.get("summary"), str)  # answer
