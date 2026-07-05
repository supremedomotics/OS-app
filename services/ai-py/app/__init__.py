"""Supreme on-box AI assistant (FastAPI).

Hosts the local model that turns natural language + home context into Supreme DSL
drafts (blueprint §10). Phase 3 ships a deterministic planner so the assistant runs
fully offline with no model weights; a real on-box LLM drops in behind `plan()`.
The Node `@supreme/ai` service calls this when SUPREME_AI_URL is configured and
falls back to its own planner otherwise.
"""
