"""Supreme protocol commissioning tooling (FastAPI).

The Python side of commissioning (blueprint §4): low-level KNX/DALI/Modbus bus
scanning that benefits from Python's protocol ecosystem. The Node commissioning
orchestrator (`@supreme/commissioning`) calls this service over loopback and
normalizes results into Supreme capabilities — protocol details never leak above
the Supreme Integration Layer.
"""
