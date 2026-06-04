"""Protocol bus simulators.

Phase-2 ships deterministic simulators so commissioning wizards are exercisable
end-to-end without physical KNX/DALI/Modbus hardware. Real scanners (xknx,
python-dali, pymodbus) drop in behind the same `scan()` signature and `Device`
shape, returning Supreme capability hints the Node orchestrator commissions.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Device:
    backend_id: str
    name: str
    capabilities: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "backend_id": self.backend_id,
            "name": self.name,
            "capabilities": self.capabilities,
        }


def scan_knx() -> list[Device]:
    return [
        Device("knx.1_1_1", "Hall Spots", ["onoff", "brightness"]),
        Device("knx.1_1_2", "Lounge Blinds", ["position"]),
        Device("knx.2_1_1", "Underfloor Heating", ["temperature"]),
    ]


def scan_dali() -> list[Device]:
    return [
        Device("dali.0.0", "Gallery Track 1", ["onoff", "brightness"]),
        Device("dali.0.1", "Gallery Track 2", ["onoff", "brightness"]),
    ]


def scan_modbus() -> list[Device]:
    return [
        Device("modbus.40001", "Main Energy Meter", ["sensor"]),
        Device("modbus.40010", "Plant Room Pump", ["onoff"]),
    ]


SCANNERS = {
    "knx": scan_knx,
    "dali": scan_dali,
    "modbus": scan_modbus,
}


def scan(protocol: str) -> list[Device]:
    scanner = SCANNERS.get(protocol)
    return scanner() if scanner else []
