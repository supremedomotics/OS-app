# Supreme on-box AI assistant (Python/FastAPI)

Hosts the local model that turns natural language + home context into Supreme DSL
drafts the user confirms (blueprint §10). The Node `@supreme/ai` service calls this
when `SUPREME_AI_URL` is set, and falls back to its own deterministic planner when
it's unavailable — so the assistant always works, online or off.

```
GET  /healthz        → { status, model: "llama.cpp" | "deterministic-planner" }
POST /plan           → an assistant draft (actions | scene | automation | answer)
```

## Real on-box LLM (llama.cpp)

The service runs a genuine local LLM via **llama-cpp-python** when a GGUF model is
provisioned — no cloud, no API keys. Decoding is JSON-constrained and the output is
validated (every referenced device id must exist); anything unusable falls back to
the deterministic planner.

```bash
# 1. install the runtime (compiles llama.cpp; CPU)
pip install '.[llm]'
# 2. provide a small instruct model (weights are NEVER committed to the repo)
bash ../../scripts/dev/fetch-ai-model.sh           # downloads a GGUF (e.g. Qwen2.5-0.5B / SmolLM2)
export SUPREME_AI_MODEL_PATH=/abs/path/to/model.gguf
# 3. run
uvicorn app.main:app --port 9200
```

In restricted networks where Hugging Face is unreachable, point `MODEL_URL` at an
allowlisted mirror, or pull a model published as a Docker Hub OCI artifact (the
`ai/` namespace) and extract the GGUF layer.

## Develop

```bash
uv sync        # or: pip install -e '.[dev]'
uv run pytest  # runs against the deterministic fallback (no weights needed)
```

The hub runs this as a sidecar; build the image with `--build-arg WITH_LLM=1` to
bake in the llama.cpp runtime and mount the model via `SUPREME_AI_MODEL_PATH`.
