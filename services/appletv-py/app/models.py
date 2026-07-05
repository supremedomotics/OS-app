"""Request models for the Apple TV bridge API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Action = Literal["play", "pause", "stop", "next", "previous", "volume", "mute", "unmute"]


class PairBeginRequest(BaseModel):
    address: str
    # Modern tvOS usually needs airplay + companion; pair each in turn.
    protocol: Literal["airplay", "companion", "mrp"] = "airplay"


class PairPinRequest(BaseModel):
    session_id: str
    pin: str = Field(min_length=4, max_length=8)


class ConnectRequest(BaseModel):
    address: str


class CommandRequest(BaseModel):
    action: Action
    volume: int | None = Field(default=None, ge=0, le=100)
