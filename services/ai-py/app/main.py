"""FastAPI app exposing the on-box assistant planner to the Node AI service."""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

from .llm import available as llm_available
from .llm import plan_llm
from .planner import plan

app = FastAPI(title="Supreme AI", version="0.0.1")


class Room(BaseModel):
    id: str
    name: str


class Device(BaseModel):
    id: str
    name: str
    roomId: str | None = None
    supremeType: str
    capabilities: list[str]


class Context(BaseModel):
    rooms: list[Room]
    devices: list[Device]


class PlanRequest(BaseModel):
    utterance: str
    context: Context


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "model": "llama.cpp" if llm_available() else "deterministic-planner"}


@app.post("/plan")
def plan_endpoint(req: PlanRequest) -> dict:
    ctx = req.context.model_dump()
    # Prefer the on-box LLM when a model is provisioned; otherwise (or if the model
    # returns nothing usable) fall back to the deterministic planner.
    return plan_llm(req.utterance, ctx) or plan(req.utterance, ctx)
