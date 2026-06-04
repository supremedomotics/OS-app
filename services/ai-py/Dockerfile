# Supreme on-box AI assistant (Python/FastAPI).
# Build context is the monorepo root (see docker-compose.yml) for the egress CA.
FROM python:3.11-slim
COPY infra/hub-compose/ca-certs/ /usr/local/share/ca-certificates/
RUN for f in /usr/local/share/ca-certificates/*.crt; do [ -f "$f" ] && cat "$f" && echo; done > /usr/local/share/proxy-ca.pem 2>/dev/null || true
WORKDIR /app
COPY services/ai-py/pyproject.toml ./
RUN [ -s /usr/local/share/proxy-ca.pem ] && export PIP_CERT=/usr/local/share/proxy-ca.pem; \
    pip install --no-cache-dir fastapi "uvicorn[standard]" pydantic
COPY services/ai-py/app ./app
EXPOSE 9200
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9200"]
