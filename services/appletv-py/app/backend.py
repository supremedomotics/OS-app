"""Apple TV control backends.

The bridge fronts `pyatv` — the de-facto Apple TV / Media Remote Protocol (MRP)
implementation — behind a small async seam so the FastAPI surface is identical
whether it's driving a real device or a fake. Two backends:

* ``PyatvBackend``  — the real one. Scans, runs the interactive PIN pairing flow,
  persists per-device credentials, holds live connections and reads "now playing".
  ``pyatv`` is imported lazily so this module loads (and the fake is testable) even
  where pyatv isn't installed (CI / dev without the heavy dep).
* ``FakeBackend``   — deterministic in-memory device used by the tests and by the
  ``SUPREME_APPLETV_FAKE=1`` smoke mode, so the Node↔bridge contract is exercised
  without any hardware.

Credentials are the only secret here; they are stored under the data dir (a Docker
volume in production) so a paired hub reconnects on boot without re-pairing.
"""

from __future__ import annotations

import abc
import asyncio
import json
import os
from dataclasses import dataclass
from pathlib import Path

# Pairing typically needs both AirPlay and Companion on modern tvOS; we store
# whatever protocols the operator pairs and replay them all on connect.
PAIRABLE_PROTOCOLS = ("airplay", "companion", "mrp")


@dataclass
class DeviceInfo:
    name: str
    address: str
    identifier: str | None = None
    model: str | None = None

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "address": self.address,
            "identifier": self.identifier,
            "model": self.model,
        }


@dataclass
class NowPlaying:
    state: str = "idle"  # playing | paused | stopped | idle
    app: str | None = None
    title: str | None = None
    artist: str | None = None
    album: str | None = None
    artwork_url: str | None = None
    volume: int = 0
    muted: bool = False

    def to_dict(self) -> dict:
        return {
            "state": self.state,
            "app": self.app,
            "title": self.title,
            "artist": self.artist,
            "album": self.album,
            "artwork_url": self.artwork_url,
            "volume": self.volume,
            "muted": self.muted,
        }


class AppleTvError(Exception):
    """A control/pairing failure surfaced to the API as a 4xx/5xx."""


class AppleTvBackend(abc.ABC):
    """Async control + pairing seam consumed by the FastAPI routes."""

    @abc.abstractmethod
    async def scan(self) -> list[DeviceInfo]: ...

    @abc.abstractmethod
    async def pair_begin(self, address: str, protocol: str) -> str: ...

    @abc.abstractmethod
    async def pair_pin(self, session_id: str, pin: str) -> list[str]: ...

    @abc.abstractmethod
    async def connect(self, address: str) -> None: ...

    @abc.abstractmethod
    async def disconnect(self, address: str) -> None: ...

    @abc.abstractmethod
    async def command(self, address: str, action: str, volume: int | None) -> None: ...

    @abc.abstractmethod
    async def now_playing(self, address: str) -> NowPlaying: ...

    @abc.abstractmethod
    def paired_addresses(self) -> list[str]: ...


class CredentialStore:
    """Per-device pyatv credentials (`{address: {protocol: credentials}}`), persisted
    as JSON so pairing survives a hub restart."""

    def __init__(self, path: str | None) -> None:
        self._path = Path(path) if path else None
        self._creds: dict[str, dict[str, str]] = {}
        if self._path and self._path.exists():
            try:
                self._creds = json.loads(self._path.read_text())
            except (OSError, ValueError):
                self._creds = {}

    def get(self, address: str) -> dict[str, str]:
        return dict(self._creds.get(address, {}))

    def put(self, address: str, protocol: str, credentials: str) -> None:
        self._creds.setdefault(address, {})[protocol] = credentials
        self._flush()

    def addresses(self) -> list[str]:
        return sorted(self._creds.keys())

    def _flush(self) -> None:
        if not self._path:
            return
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # 0600 — credentials are sensitive.
        self._path.write_text(json.dumps(self._creds, indent=2))
        try:
            os.chmod(self._path, 0o600)
        except OSError:
            pass


# ── Fake backend (tests + smoke mode) ──────────────────────────────────────────


@dataclass
class _FakeDevice:
    info: DeviceInfo
    now: NowPlaying
    paired: bool = False
    connected: bool = False
    _last_volume: int = 40


@dataclass
class _PairSession:
    address: str
    protocol: str


class FakeBackend(AppleTvBackend):
    """An in-memory Apple TV: one 'Living Room' device playing Netflix. Deterministic
    so the API contract can be tested without hardware (no random/clock use)."""

    def __init__(self) -> None:
        self._devices: dict[str, _FakeDevice] = {
            "10.0.0.42": _FakeDevice(
                info=DeviceInfo("Living Room", "10.0.0.42", "AA:BB:CC:DD:EE:FF", "Apple TV 4K"),
                now=NowPlaying(
                    state="paused",
                    app="Netflix",
                    title="The Crown",
                    artist="S5 · E3",
                    album=None,
                    artwork_url=None,
                    volume=40,
                    muted=False,
                ),
            )
        }
        self._sessions: dict[str, _PairSession] = {}
        self._seq = 0

    async def scan(self) -> list[DeviceInfo]:
        return [d.info for d in self._devices.values()]

    async def pair_begin(self, address: str, protocol: str) -> str:
        if protocol not in PAIRABLE_PROTOCOLS:
            raise AppleTvError(f"unknown protocol {protocol}")
        if address not in self._devices:
            raise AppleTvError(f"no device at {address}")
        self._seq += 1
        sid = f"sess-{self._seq}"
        self._sessions[sid] = _PairSession(address=address, protocol=protocol)
        return sid

    async def pair_pin(self, session_id: str, pin: str) -> list[str]:
        sess = self._sessions.pop(session_id, None)
        if not sess:
            raise AppleTvError("unknown pairing session")
        if not (pin.isdigit() and len(pin) == 4):
            raise AppleTvError("PIN must be 4 digits")
        dev = self._devices[sess.address]
        dev.paired = True
        return [sess.protocol]

    async def connect(self, address: str) -> None:
        dev = self._devices.get(address)
        if not dev:
            raise AppleTvError(f"no device at {address}")
        dev.connected = True

    async def disconnect(self, address: str) -> None:
        if address in self._devices:
            self._devices[address].connected = False

    async def command(self, address: str, action: str, volume: int | None) -> None:
        dev = self._require_connected(address)
        np = dev.now
        if action == "play":
            np.state = "playing"
        elif action == "pause":
            np.state = "paused"
        elif action == "stop":
            np.state = "stopped"
        elif action in ("next", "previous"):
            pass  # transport skip; content title is left to the fake's script
        elif action == "volume":
            if volume is None:
                raise AppleTvError("volume action requires a volume")
            np.volume = max(0, min(100, volume))
            dev._last_volume = np.volume
        elif action == "mute":
            np.muted = True
        elif action == "unmute":
            np.muted = False
        else:
            raise AppleTvError(f"unsupported action {action}")

    async def now_playing(self, address: str) -> NowPlaying:
        return self._require_connected(address).now

    def paired_addresses(self) -> list[str]:
        return [a for a, d in self._devices.items() if d.paired]

    def _require_connected(self, address: str) -> _FakeDevice:
        dev = self._devices.get(address)
        if not dev:
            raise AppleTvError(f"no device at {address}")
        if not dev.connected:
            raise AppleTvError(f"{address} not connected")
        return dev


# ── Real pyatv backend ──────────────────────────────────────────────────────────


@dataclass
class _Connection:
    atv: object  # pyatv.interface.AppleTV
    last_volume: int = 40


class PyatvBackend(AppleTvBackend):
    """Real Apple TV control via pyatv. The pyatv import is lazy so this class can be
    constructed anywhere; methods raise a clear error if pyatv isn't installed."""

    def __init__(self, store: CredentialStore) -> None:
        self._store = store
        self._conns: dict[str, _Connection] = {}
        self._pairings: dict[str, object] = {}  # session_id -> (pairing, config, protocol)
        self._seq = 0

    @staticmethod
    def _pyatv():
        try:
            import pyatv  # noqa: PLC0415  (lazy: heavy optional dep)
            import pyatv.const  # noqa: PLC0415

            return pyatv
        except ImportError as exc:  # pragma: no cover - env without pyatv
            raise AppleTvError(
                "pyatv is not installed — build the appletv-py image (it pip-installs pyatv)"
            ) from exc

    @staticmethod
    def _protocol(pyatv, name: str):
        from pyatv.const import Protocol  # noqa: PLC0415

        mapping = {
            "airplay": Protocol.AirPlay,
            "companion": Protocol.Companion,
            "mrp": Protocol.MRP,
        }
        if name not in mapping:
            raise AppleTvError(f"unknown protocol {name}")
        return mapping[name]

    async def _config_for(self, pyatv, address: str):
        confs = await pyatv.scan(asyncio.get_event_loop(), hosts=[address], timeout=5)
        if not confs:
            raise AppleTvError(f"no Apple TV found at {address}")
        return confs[0]

    async def scan(self) -> list[DeviceInfo]:
        pyatv = self._pyatv()
        confs = await pyatv.scan(asyncio.get_event_loop(), timeout=5)
        out: list[DeviceInfo] = []
        for c in confs:
            out.append(
                DeviceInfo(
                    name=c.name,
                    address=str(c.address),
                    identifier=c.identifier,
                    model=getattr(c, "device_info", None) and str(c.device_info.model),
                )
            )
        return out

    async def pair_begin(self, address: str, protocol: str) -> str:
        pyatv = self._pyatv()
        config = await self._config_for(pyatv, address)
        proto = self._protocol(pyatv, protocol)
        pairing = await pyatv.pair(config, proto, asyncio.get_event_loop())
        await pairing.begin()
        self._seq += 1
        sid = f"sess-{self._seq}"
        self._pairings[sid] = (pairing, config, protocol)
        return sid

    async def pair_pin(self, session_id: str, pin: str) -> list[str]:
        entry = self._pairings.pop(session_id, None)
        if not entry:
            raise AppleTvError("unknown pairing session")
        pairing, config, protocol = entry
        pyatv = self._pyatv()
        try:
            pairing.pin(pin)
            await pairing.finish()
            if not pairing.has_paired:
                raise AppleTvError("pairing failed — wrong PIN?")
            service = config.get_service(self._protocol(pyatv, protocol))
            if not service or not service.credentials:
                raise AppleTvError("no credentials returned by pairing")
            self._store.put(config.address and str(config.address) or "", protocol, service.credentials)
            return [protocol]
        finally:
            await pairing.close()

    async def connect(self, address: str) -> None:
        if address in self._conns:
            return
        pyatv = self._pyatv()
        creds = self._store.get(address)
        if not creds:
            raise AppleTvError(f"{address} is not paired — run the pairing flow first")
        config = await self._config_for(pyatv, address)
        for proto_name, cred in creds.items():
            config.set_credentials(self._protocol(pyatv, proto_name), cred)
        atv = await pyatv.connect(config, asyncio.get_event_loop())
        self._conns[address] = _Connection(atv=atv)

    async def disconnect(self, address: str) -> None:
        conn = self._conns.pop(address, None)
        if conn:
            close = getattr(conn.atv, "close", None)
            if close:
                close()

    async def command(self, address: str, action: str, volume: int | None) -> None:
        conn = self._conns.get(address)
        if not conn:
            await self.connect(address)
            conn = self._conns[address]
        atv = conn.atv
        rc = atv.remote_control  # type: ignore[attr-defined]
        audio = atv.audio  # type: ignore[attr-defined]
        if action == "play":
            await rc.play()
        elif action == "pause":
            await rc.pause()
        elif action == "stop":
            await rc.stop()
        elif action == "next":
            await rc.next()
        elif action == "previous":
            await rc.previous()
        elif action == "volume":
            if volume is None:
                raise AppleTvError("volume action requires a volume")
            conn.last_volume = max(0, min(100, volume))
            await audio.set_volume(float(conn.last_volume))
        elif action == "mute":
            # pyatv has no native mute — drop output to 0 and remember the level.
            conn.last_volume = int(getattr(audio, "volume", conn.last_volume) or conn.last_volume)
            await audio.set_volume(0.0)
        elif action == "unmute":
            await audio.set_volume(float(conn.last_volume))
        else:
            raise AppleTvError(f"unsupported action {action}")

    async def now_playing(self, address: str) -> NowPlaying:
        conn = self._conns.get(address)
        if not conn:
            await self.connect(address)
            conn = self._conns[address]
        atv = conn.atv
        from pyatv.const import DeviceState  # noqa: PLC0415

        playing = await atv.metadata.playing()  # type: ignore[attr-defined]
        state_map = {
            DeviceState.Playing: "playing",
            DeviceState.Paused: "paused",
            DeviceState.Stopped: "stopped",
            DeviceState.Idle: "idle",
            DeviceState.Loading: "playing",
            DeviceState.Seeking: "playing",
        }
        app = getattr(atv.metadata, "app", None)  # type: ignore[attr-defined]
        try:
            vol = int(await atv.audio.volume)  # type: ignore[attr-defined]
        except Exception:  # noqa: BLE001 - volume not always available
            vol = conn.last_volume
        return NowPlaying(
            state=state_map.get(getattr(playing, "device_state", None), "idle"),
            app=getattr(app, "name", None) if app else None,
            title=getattr(playing, "title", None),
            artist=getattr(playing, "artist", None) or getattr(playing, "series_name", None),
            album=getattr(playing, "album", None),
            artwork_url=None,  # artwork is bytes via pyatv; proxying it is a follow-up
            volume=max(0, min(100, vol)),
            muted=vol == 0,
        )

    def paired_addresses(self) -> list[str]:
        return self._store.addresses()


def make_backend() -> AppleTvBackend:
    """Select the backend from the environment (fake for tests/smoke; pyatv otherwise)."""
    if os.environ.get("SUPREME_APPLETV_FAKE") in ("1", "true"):
        return FakeBackend()
    return PyatvBackend(CredentialStore(os.environ.get("SUPREME_APPLETV_DATA", "/data/appletv-creds.json")))
