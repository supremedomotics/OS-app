"""FastAPI app exposing the on-box assistant planner to the Node AI service."""

from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel

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
    return {"status": "ok", "model": "deterministic-planner"}


@app.post("/plan")
def plan_endpoint(req: PlanRequest) -> dict:
    return plan(req.utterance, req.context.model_dump())
