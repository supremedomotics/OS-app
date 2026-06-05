# Supreme on-box AI assistant (Python/FastAPI + optional llama.cpp).
# Build context is the monorepo root (see docker-compose.yml) for the egress CA.
#
# By default this builds the lightweight service (deterministic planner). To bake
# in the on-box LLM runtime, build with `--build-arg WITH_LLM=1` (compiles
# llama-cpp-python) and provide a GGUF at runtime via SUPREME_AI_MODEL_PATH (mount
# the model; weights are never shipped in the image/repo).
FROM python:3.11-slim
ARG WITH_LLM=0
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true
WORKDIR /app
COPY services/ai-py/pyproject.toml ./
RUN [ -s /usr/local/share/proxy-ca.pem ] && export PIP_CERT=/usr/local/share/proxy-ca.pem; \
    pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic && \
    if [ "$WITH_LLM" = "1" ]; then \
      apt-get update && apt-get install -y --no-install-recommends build-essential cmake && \
      CMAKE_ARGS="-DGGML_NATIVE=OFF" pip install --no-cache-dir "llama-cpp-python>=0.3.0" && \
      apt-get purge -y build-essential cmake && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*; \
    fi
COPY services/ai-py/app ./app
EXPOSE 9200
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9200"]
