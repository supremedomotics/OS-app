# scenes captures

Empty as of this session. `event-engine.ts`'s `normalizeLocalPacket` handles opcode 0x0d (Scene
Called) as `sceneRaw` but only logs it via the tracer today — see `event-engine.ts`'s own doc
comment: "No unitId/sceneId to publish as a typed event yet." A real scene-call capture would be
the first concrete evidence needed to design that mapping honestly rather than guess at it.
Reserved for real hardware captures — see the parent directory's `README.md` for the Live Capture
workflow.
