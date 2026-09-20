# Supreme OS Windows Simulation Lab

Standalone Electron application for Windows. It generates large virtual smart-home installations and exercises Supreme OS with state events, deterministic scenarios and fault injection.

Run from the repository root:

pnpm install
pnpm --dir apps/windows-simulator start

Build a Windows x64 installer:

pnpm --dir apps/windows-simulator dist

The simulator supports 10–5,000 virtual devices across 20 rooms, KNX/DALI/Matter/Casambi/MQTT/Modbus/AVR/Zigbee/Lutron/media models, event bursts, latency, packet loss, offline devices, duplicate/reordered events, malformed feedback, gateway outage and reconnect scenarios.

It can also health-check a local Supreme OS gateway and optionally send a simulation snapshot to an explicitly supported import endpoint.
