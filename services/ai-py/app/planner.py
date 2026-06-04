"""Deterministic NL → Supreme DSL planner (offline stand-in for a local LLM).

Mirrors the contract of the Node `@supreme/ai` planner: given an utterance and home
context, return a draft the user confirms. Kept intentionally simple; a real on-box
model replaces `plan()` without changing the HTTP contract.
"""

from __future__ import annotations

import re

LIGHTING = {"light", "dimmer", "color_light"}


def _resolve_targets(u: str, ctx: dict) -> list[dict]:
    want_lights = bool(re.search(r"\blights?\b", u))
    if re.search(r"\b(all|every)\b[^.]*\blights?\b", u):
        return [d for d in ctx["devices"] if d["supremeType"] in LIGHTING]
    out: list[dict] = []
    for room in ctx["rooms"]:
        if room["name"].lower() in u:
            devs = [d for d in ctx["devices"] if d.get("roomId") == room["id"]]
            out += [d for d in devs if d["supremeType"] in LIGHTING] if want_lights else devs
    for d in ctx["devices"]:
        if d["name"].lower() in u:
            out.append(d)
    seen, unique = set(), []
    for d in out:
        if d["id"] not in seen:
            seen.add(d["id"])
            unique.append(d)
    if not unique and want_lights:
        return [d for d in ctx["devices"] if d["supremeType"] in LIGHTING]
    return unique


def _level(u: str) -> int | None:
    m = re.search(r"(\d{1,3})\s*%", u)
    if m:
        return max(0, min(100, int(m.group(1))))
    return None


def _command_for(d: dict, u: str, level: int | None) -> dict | None:
    caps = d["capabilities"]
    if "unlock" in u and "lock" in caps:
        return {"capability": "lock", "action": "unlock"}
    if re.search(r"\block\b", u) and "lock" in caps:
        return {"capability": "lock", "action": "lock"}
    if level is not None and "brightness" in caps:
        return {"capability": "brightness", "action": "set", "level": level}
    if re.search(r"\boff\b", u):
        if "brightness" in caps:
            return {"capability": "brightness", "action": "off"}
        if "onoff" in caps:
            return {"capability": "onoff", "action": "off"}
    if re.search(r"\bon\b", u):
        if "brightness" in caps:
            return {"capability": "brightness", "action": "on"}
        if "onoff" in caps:
            return {"capability": "onoff", "action": "on"}
    return None


def plan(utterance: str, ctx: dict) -> dict:
    u = utterance.lower().strip()
    level = _level(u)
    commands = []
    for d in _resolve_targets(u, ctx):
        c = _command_for(d, u, level)
        if c:
            commands.append({"deviceId": d["id"], "deviceName": d["name"], "command": c})
    if commands:
        summary = "; ".join(f"{c['deviceName']}: {c['command']['capability']}" for c in commands)
        return {"kind": "actions", "summary": summary, "commands": commands}
    return {
        "kind": "answer",
        "summary": "I couldn't find a matching device or action. Try naming a room or device.",
    }
